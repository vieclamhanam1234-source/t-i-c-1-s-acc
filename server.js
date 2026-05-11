require('dotenv').config();
const express = require('express');
const { Telegraf } = require('telegraf');
const { spawn } = require('child_process');

const PORT = Number(process.env.PORT || 3000);
const BOT_TOKEN = process.env.BOT_TOKEN;
const WEBHOOK_PATH = process.env.WEBHOOK_PATH || '/telegram/webhook';
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || 'change-me';
const BASE_URL = process.env.BASE_URL;
const ALLOWED_USER_IDS = new Set(
  (process.env.ALLOWED_USER_IDS || '')
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean)
);
const POLLO_ACCOUNTS = (process.env.POLLO_ACCOUNTS || '')
  .split(',')
  .map((v) => v.trim())
  .filter(Boolean);

if (!BOT_TOKEN) {
  throw new Error('Missing BOT_TOKEN');
}
if (!BASE_URL) {
  throw new Error('Missing BASE_URL');
}
if (POLLO_ACCOUNTS.length === 0) {
  throw new Error('Missing POLLO_ACCOUNTS');
}

class AccountPool {
  constructor(accounts) {
    this.accounts = accounts.map((raw, idx) => {
      // Format: sessionToken|csrfToken
      const [sessionToken, csrfToken] = raw.split('|').map((v) => (v || '').trim());
      return { id: idx + 1, sessionToken, csrfToken, busy: false };
    });
    this.pointer = 0;
  }

  acquire() {
    for (let i = 0; i < this.accounts.length; i += 1) {
      const idx = (this.pointer + i) % this.accounts.length;
      if (!this.accounts[idx].busy) {
        this.accounts[idx].busy = true;
        this.pointer = (idx + 1) % this.accounts.length;
        return this.accounts[idx];
      }
    }
    return null;
  }

  release(accountId) {
    const acc = this.accounts.find((a) => a.id === accountId);
    if (acc) acc.busy = false;
  }
}

class JobQueue {
  constructor(worker, concurrency = 2) {
    this.worker = worker;
    this.concurrency = concurrency;
    this.running = 0;
    this.queue = [];
  }

  push(job) {
    this.queue.push(job);
    this.drain();
  }

  async drain() {
    while (this.running < this.concurrency && this.queue.length > 0) {
      const job = this.queue.shift();
      this.running += 1;
      this.worker(job)
        .catch((err) => {
          console.error('Job failed:', err.message);
        })
        .finally(() => {
          this.running -= 1;
          this.drain();
        });
    }
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function runPolloWorker({ account, promptText, imageUrl }) {
  return new Promise((resolve, reject) => {
    const args = [
      'worker.py',
      '--session', account.sessionToken,
      '--csrf', account.csrfToken,
      '--prompt', promptText,
      '--image-url', imageUrl,
    ];
    const py = spawn('python3', args, { cwd: process.cwd() });
    let stdout = '';
    let stderr = '';
    py.stdout.on('data', (d) => { stdout += d.toString(); });
    py.stderr.on('data', (d) => { stderr += d.toString(); });
    py.on('error', (e) => reject(new Error(`spawn python failed: ${e.message}`)));
    py.on('close', (code) => {
      const out = stdout.trim().split('\n').filter(Boolean).pop() || '';
      if (code !== 0) return reject(new Error(stderr || out || `worker exit ${code}`));
      try {
        const data = JSON.parse(out);
        if (!data.ok) return reject(new Error(data.error || 'worker failed'));
        resolve(data);
      } catch (e) {
        reject(new Error(`worker invalid json: ${out.slice(0, 300)}`));
      }
    });
  });
}

async function uploadTelegramImageToPollo({ account, telegramFileUrl, filename, mimeType }) {
  const imgRes = await fetch(telegramFileUrl);
  if (!imgRes.ok) throw new Error(`Download Telegram image failed: HTTP ${imgRes.status}`);
  const imageBuffer = Buffer.from(await imgRes.arrayBuffer());
  const uploadInit = await fetch('https://pollo.ai/api/upload/sign', {
    method: 'POST',
    headers: {
      accept: '*/*',
      'content-type': 'application/json',
      origin: 'https://pollo.ai',
      referer: 'https://pollo.ai/create?target=image-to-image',
      'user-agent': 'Mozilla/5.0',
      cookie: `__Secure-next-auth.session-token=${account.sessionToken}; __Host-next-auth.csrf-token=${account.csrfToken}`,
    },
    body: JSON.stringify({
      filename,
      filetype: mimeType,
      filesize: imageBuffer.length,
      type: 'image',
    }),
  });
  const signData = await uploadInit.json();
  if (!signData?.sign || !signData?.accessURL) {
    throw new Error('Cannot get upload signed URL from Pollo');
  }
  const putRes = await fetch(signData.sign, {
    method: 'PUT',
    headers: { 'Content-Type': mimeType },
    body: imageBuffer,
  });
  if (!putRes.ok) throw new Error(`Upload to Pollo storage failed: HTTP ${putRes.status}`);
  return signData.accessURL;
}


const app = express();
const bot = new Telegraf(BOT_TOKEN);
const pool = new AccountPool(POLLO_ACCOUNTS);
const jobState = new Map();
const pendingCreate = new Map();

function isAllowed(ctx) {
  if (ALLOWED_USER_IDS.size === 0) return true;
  const uid = String(ctx.from?.id || '');
  return ALLOWED_USER_IDS.has(uid);
}

bot.use(async (ctx, next) => {
  console.log('[update] type=', ctx.updateType, 'from=', ctx.from?.id, 'chat=', ctx.chat?.id);
  if (!isAllowed(ctx)) {
    console.log('[auth] blocked by whitelist user=', ctx.from?.id);
    await ctx.reply('Ban khong nam trong whitelist.');
    return;
  }
  await next();
});

bot.start(async (ctx) => {
  await ctx.reply('Bot san sang. Dung: /create <prompt>\nVi du: /create cinematic cyberpunk city');
});

bot.command('help', async (ctx) => {
  await ctx.reply('/create <prompt>\n/status <job_id>\nGui them 1 anh trong cung tin nhan /create.\nPOLLO_ACCOUNTS format: session|csrf[,session|csrf]');
});

bot.command('status', async (ctx) => {
  const args = (ctx.message.text || '').split(' ').slice(1);
  const jobId = args[0];
  if (!jobId) {
    await ctx.reply('Dung: /status <job_id>');
    return;
  }
  const job = jobState.get(jobId);
  if (!job) {
    await ctx.reply('Khong tim thay job.');
    return;
  }
  await ctx.reply(`Job ${jobId}: ${job.status}` + (job.videoUrl ? `\n${job.videoUrl}` : ''));
});

bot.command('create', async (ctx) => {
  const rawInput = ctx.message?.text || ctx.message?.caption || '';
  const prompt = rawInput.replace('/create', '').trim();
  console.log('[create] rawInput=', rawInput);
  if (!prompt) {
    console.log('[create] missing prompt');
    await ctx.reply('Sai cu phap. Dung: /create <prompt>');
    return;
  }
  const photos = ctx.message.photo || [];
  console.log('[create] hasPhoto=', photos.length > 0, 'photoCount=', photos.length);
  if (photos.length === 0) {
    pendingCreate.set(String(ctx.from?.id || ''), { prompt, createdAt: Date.now() });
    await ctx.reply('Da nhan prompt. Gio hay gui 1 anh de bat dau tao.');
    return;
  }
  const bestPhoto = photos[photos.length - 1];
  console.log('[create] fetch telegram file_id=', bestPhoto.file_id);
  const file = await bot.telegram.getFile(bestPhoto.file_id);
  const telegramFileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`;
  const seed = String(Date.now());

  const jobId = `job_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
  jobState.set(jobId, { status: 'queued', createdAt: Date.now(), seed, prompt });

  queue.push({
    jobId,
    chatId: ctx.chat.id,
    seed,
    prompt: {
      text: prompt,
      imageUrl: telegramFileUrl,
      filename: `telegram_${bestPhoto.file_id}.jpg`,
      mimeType: 'image/jpeg',
    },
  });
  console.log('[create] queued job=', jobId, 'chatId=', ctx.chat.id);

  await ctx.reply(`Da xep hang: ${jobId}`);
});

bot.on('photo', async (ctx) => {
  const uid = String(ctx.from?.id || '');
  const pending = pendingCreate.get(uid);
  if (!pending) return;
  if (Date.now() - pending.createdAt > 10 * 60 * 1000) {
    pendingCreate.delete(uid);
    await ctx.reply('Prompt da het han. Hay gui lai /create <prompt>.');
    return;
  }

  const photos = ctx.message.photo || [];
  if (photos.length === 0) return;
  const bestPhoto = photos[photos.length - 1];
  const file = await bot.telegram.getFile(bestPhoto.file_id);
  const telegramFileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`;
  const seed = String(Date.now());
  const jobId = `job_${Date.now()}_${Math.floor(Math.random() * 1000)}`;

  jobState.set(jobId, { status: 'queued', createdAt: Date.now(), seed, prompt: pending.prompt });
  queue.push({
    jobId,
    chatId: ctx.chat.id,
    seed,
    prompt: {
      text: pending.prompt,
      imageUrl: telegramFileUrl,
      filename: `telegram_${bestPhoto.file_id}.jpg`,
      mimeType: 'image/jpeg',
    },
  });
  pendingCreate.delete(uid);
  await ctx.reply(`Da xep hang: ${jobId}`);
});

const queue = new JobQueue(async (job) => {
  const account = pool.acquire();
  if (!account) {
    jobState.set(job.jobId, { ...jobState.get(job.jobId), status: 'waiting_account' });
    await sleep(2000);
    queue.push(job);
    return;
  }

  try {
    jobState.set(job.jobId, { ...jobState.get(job.jobId), status: `running_acc_${account.id}` });
    const workerResult = await runPolloWorker({
      account,
      promptText: job.prompt.text,
      imageUrl: job.prompt.imageUrl,
    });
    const taskId = workerResult.task_id || 'unknown';
    if (workerResult.image_url) {
      jobState.set(job.jobId, { ...jobState.get(job.jobId), status: 'done', taskId, imageUrl: workerResult.image_url });
      try {
        await bot.telegram.sendPhoto(job.chatId, workerResult.image_url, {
          caption: `Job ${job.jobId} xong.\nTask ID: ${taskId}`,
        });
      } catch (_) {
        await bot.telegram.sendMessage(job.chatId, `Job ${job.jobId} xong: ${workerResult.image_url}`);
      }
    } else {
      jobState.set(job.jobId, { ...jobState.get(job.jobId), status: 'timeout_wait_result', taskId });
      await bot.telegram.sendMessage(job.chatId, `Job ${job.jobId} timeout khi doi ket qua. Task ID: ${taskId}`);
    }
  } catch (err) {
    jobState.set(job.jobId, { ...jobState.get(job.jobId), status: `failed: ${err.message}` });
    await bot.telegram.sendMessage(job.chatId, `Job ${job.jobId} loi: ${err.message}`);
  } finally {
    pool.release(account.id);
  }
}, 2);

app.use(express.json());
app.get('/healthz', (_, res) => res.status(200).json({ ok: true }));

app.post(WEBHOOK_PATH, (req, res) => {
  console.log('[webhook] incoming update_id=', req.body?.update_id, 'keys=', Object.keys(req.body || {}));
  const secret = req.headers['x-telegram-bot-api-secret-token'];
  if (secret !== WEBHOOK_SECRET) {
    console.log('[webhook] unauthorized secret mismatch');
    res.status(401).send('unauthorized');
    return;
  }
  bot.handleUpdate(req.body, res);
});

async function bootstrap() {
  const webhookUrl = `${BASE_URL}${WEBHOOK_PATH}`;
  await bot.telegram.setWebhook(webhookUrl, {
    secret_token: WEBHOOK_SECRET,
    drop_pending_updates: false,
  });

  app.listen(PORT, () => {
    console.log(`Server listening on ${PORT}`);
    console.log(`Webhook: ${webhookUrl}`);
  });
}

bootstrap().catch((err) => {
  console.error(err);
  process.exit(1);
});
