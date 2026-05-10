require('dotenv').config();
const express = require('express');
const { Telegraf } = require('telegraf');

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
    this.accounts = accounts.map((token, idx) => ({ id: idx + 1, token, busy: false }));
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

async function createVideoOnPollo({ prompt, seed, accountToken }) {
  // TODO: Replace this mock with real Pollo API call.
  // Example flow:
  // 1) POST create job with accountToken
  // 2) poll status endpoint until done
  // 3) return final video URL
  await sleep(8000);
  const suffix = encodeURIComponent(`${prompt}-${seed}-${Date.now()}`);
  return `https://example.com/video/${suffix}.mp4`;
}

const app = express();
const bot = new Telegraf(BOT_TOKEN);
const pool = new AccountPool(POLLO_ACCOUNTS);
const jobState = new Map();

function isAllowed(ctx) {
  if (ALLOWED_USER_IDS.size === 0) return true;
  const uid = String(ctx.from?.id || '');
  return ALLOWED_USER_IDS.has(uid);
}

bot.use(async (ctx, next) => {
  if (!isAllowed(ctx)) {
    await ctx.reply('Ban khong nam trong whitelist.');
    return;
  }
  await next();
});

bot.start(async (ctx) => {
  await ctx.reply('Bot san sang. Dung: /create <seed>|<prompt>\nVi du: /create 12345|cinematic cyberpunk city');
});

bot.command('help', async (ctx) => {
  await ctx.reply('/create <seed>|<prompt>\n/status <job_id>');
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
  const payload = (ctx.message.text || '').replace('/create', '').trim();
  const splitIndex = payload.indexOf('|');
  if (splitIndex === -1) {
    await ctx.reply('Sai cu phap. Dung: /create <seed>|<prompt>');
    return;
  }

  const seed = payload.slice(0, splitIndex).trim();
  const prompt = payload.slice(splitIndex + 1).trim();
  if (!seed || !prompt) {
    await ctx.reply('Seed va prompt khong duoc de trong.');
    return;
  }

  const jobId = `job_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
  jobState.set(jobId, { status: 'queued', createdAt: Date.now(), seed, prompt });

  queue.push({
    jobId,
    chatId: ctx.chat.id,
    seed,
    prompt,
  });

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
    const videoUrl = await createVideoOnPollo({
      prompt: job.prompt,
      seed: job.seed,
      accountToken: account.token,
    });

    jobState.set(job.jobId, { ...jobState.get(job.jobId), status: 'done', videoUrl });
    await bot.telegram.sendMessage(job.chatId, `Job ${job.jobId} xong: ${videoUrl}`);
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
  const secret = req.headers['x-telegram-bot-api-secret-token'];
  if (secret !== WEBHOOK_SECRET) {
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