import json
import time

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from playwright.sync_api import sync_playwright

app = FastAPI()


def launch_browser_safe(playwright):
    return playwright.chromium.launch(
        headless=True,
        chromium_sandbox=False,
        args=[
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--single-process',
            '--no-zygote',
            '--disable-software-rasterizer',
            '--disable-background-networking',
            '--disable-extensions',
            '--disable-features=site-per-process,IsolateOrigins',
        ],
    )


class GenerateIn(BaseModel):
    session: str
    csrf: str
    prompt: str
    image_url: str


@app.get('/healthz')
def healthz():
    return {'ok': True}


@app.post('/generate')
def generate(inp: GenerateIn):
    browser = None
    cookies = [
        {
            'name': '__Secure-next-auth.session-token',
            'value': inp.session,
            'domain': 'pollo.ai',
            'path': '/',
            'httpOnly': True,
            'secure': True,
            'sameSite': 'Lax',
        },
        {
            'name': '__Host-next-auth.csrf-token',
            'value': inp.csrf,
            'domain': 'pollo.ai',
            'path': '/',
            'httpOnly': True,
            'secure': True,
            'sameSite': 'Lax',
        },
    ]

    payload = {
        '0': {
            'json': {
                'projectId': 'cmof6s7i904jdoguj5o8pxnqi',
                'entryCode': 'ImageToImage',
                'modelName': 'openai-gpt-image-2-0',
                'imageUrl': inp.image_url,
                'images': [inp.image_url],
                'prompt': inp.prompt,
                'aspectRatio': '9:16',
                'resolution': '1K',
                'quality': 'medium',
                'numOutputs': 1,
                'mode': 'standard',
                'outputFormat': 'png',
                'outputQuality': 80,
                'enableTranslatePrompt': False,
                'enableMagicPrompt': False,
                'published': True,
                'protectionMode': False,
                'resourceObj': {'resource_type': ''},
            }
        }
    }

    try:
        with sync_playwright() as p:
            browser = launch_browser_safe(p)
            context = browser.new_context()
            context.add_cookies(cookies)
            page = context.new_page()

            page.goto('https://pollo.ai/create?target=image-to-image', wait_until='domcontentloaded', timeout=60000)

            create_out = page.evaluate(
                """
                async ({payload}) => {
                  const res = await fetch('https://pollo.ai/api/trpc/image2Image.create?batch=1', {
                    method: 'POST',
                    credentials: 'include',
                    headers: {
                      'accept': '*/*',
                      'content-type': 'application/json'
                    },
                    body: JSON.stringify(payload)
                  });
                  const text = await res.text();
                  return { status: res.status, text };
                }
                """,
                {'payload': payload},
            )
            if create_out.get('status') != 200:
                raise HTTPException(status_code=502, detail=f"create HTTP {create_out.get('status')}: {create_out.get('text','')[:240]}")

            try:
                create_data = json.loads(create_out.get('text', ''))
            except Exception:
                raise HTTPException(status_code=502, detail=f"create non-json: {create_out.get('text','')[:240]}")

            task_id = create_data[0].get('result', {}).get('data', {}).get('json', {}).get('id')
            if not task_id:
                raise HTTPException(status_code=502, detail='missing task_id')

            for _ in range(40):
                status_out = page.evaluate(
                    """
                    async ({taskId}) => {
                      const input = JSON.stringify({0:{json:{id:Number(taskId)}}});
                      const url = `https://pollo.ai/api/trpc/generation.queryRecordDetail?batch=1&input=${encodeURIComponent(input)}`;
                      const res = await fetch(url, {
                        method: 'GET',
                        credentials: 'include',
                        headers: {'accept': '*/*'}
                      });
                      const text = await res.text();
                      return { status: res.status, text };
                    }
                    """,
                    {'taskId': task_id},
                )
                if status_out.get('status') != 200:
                    time.sleep(4)
                    continue
                try:
                    body = json.loads(status_out.get('text', ''))[0].get('result', {}).get('data', {}).get('json', {})
                except Exception:
                    time.sleep(4)
                    continue

                status = str(body.get('status', '')).lower()
                outputs = body.get('images') or body.get('outputImages') or body.get('imageUrls') or body.get('outputs') or []
                image_url = next((x for x in outputs if isinstance(x, str) and x.startswith('http')), None) if isinstance(outputs, list) else None
                if image_url:
                    return {'ok': True, 'task_id': str(task_id), 'image_url': image_url}
                if 'fail' in status:
                    raise HTTPException(status_code=502, detail=body.get('failMsg') or 'generation failed')
                time.sleep(4)

            return {'ok': True, 'task_id': str(task_id), 'timeout': True, 'image_url': None}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=502, detail=f'create request failed: {str(e)[:240]}')
    finally:
        if browser is not None:
            try:
                browser.close()
            except Exception:
                pass
