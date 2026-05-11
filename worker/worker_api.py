import json
import os
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from playwright.sync_api import sync_playwright

app = FastAPI()


class GenerateIn(BaseModel):
    session: str
    csrf: str
    prompt: str
    image_url: str


def to_pw_cookie(c):
    out = {
        'name': c['name'],
        'value': c['value'],
        'domain': c.get('domain', 'pollo.ai'),
        'path': c.get('path', '/'),
        'httpOnly': c.get('httpOnly', False),
        'secure': c.get('secure', False),
    }
    same_site = c.get('sameSite')
    if same_site:
        ss = str(same_site).lower()
        if ss == 'lax':
            out['sameSite'] = 'Lax'
        elif ss == 'strict':
            out['sameSite'] = 'Strict'
        elif ss == 'none':
            out['sameSite'] = 'None'
    if not c.get('session') and c.get('expirationDate'):
        out['expires'] = int(c['expirationDate'])
    return out


@app.get('/healthz')
def healthz():
    return {'ok': True}


@app.post('/generate')
def generate(inp: GenerateIn):
    cookie_json = os.getenv('POLLO_COOKIE_JSON', '[]')
    try:
        cookies_raw = json.loads(cookie_json)
    except Exception:
        raise HTTPException(status_code=500, detail='Invalid POLLO_COOKIE_JSON')

    if not isinstance(cookies_raw, list):
        raise HTTPException(status_code=500, detail='POLLO_COOKIE_JSON must be a JSON array')

    # Override auth cookies from payload to keep account rotation via bot.
    cookies_raw = [c for c in cookies_raw if c.get('name') not in ['__Secure-next-auth.session-token', '__Host-next-auth.csrf-token']]
    cookies_raw.append({
        'name': '__Secure-next-auth.session-token',
        'value': inp.session,
        'domain': 'pollo.ai',
        'path': '/',
        'httpOnly': True,
        'secure': True,
        'sameSite': 'lax',
        'session': False,
    })
    cookies_raw.append({
        'name': '__Host-next-auth.csrf-token',
        'value': inp.csrf,
        'domain': 'pollo.ai',
        'path': '/',
        'httpOnly': True,
        'secure': True,
        'sameSite': 'lax',
        'session': True,
    })

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
            browser = p.chromium.launch(
                headless=True,
                args=[
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-gpu',
                ],
            )
            context = browser.new_context()
            context.add_cookies([to_pw_cookie(c) for c in cookies_raw])
            page = context.new_page()

            try:
                page.goto('https://pollo.ai/create?target=image-to-image', wait_until='domcontentloaded', timeout=60000)
                out = page.evaluate(
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
            finally:
                browser.close()
    except Exception as e:
        raise HTTPException(status_code=502, detail=f'create request failed: {str(e)[:240]}')

    if out.get('status') != 200:
        raise HTTPException(status_code=502, detail=f"create HTTP {out.get('status')}: {out.get('text','')[:240]}")

    try:
        data = json.loads(out.get('text', ''))
    except Exception:
        raise HTTPException(status_code=502, detail=f"create non-json: {out.get('text','')[:240]}")

    task_id = data[0].get('result', {}).get('data', {}).get('json', {}).get('id')
    if not task_id:
        raise HTTPException(status_code=502, detail='missing task_id')

    return {'ok': True, 'task_id': str(task_id)}
