from urllib.parse import quote
import json
import time

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from curl_cffi import requests
from playwright.sync_api import sync_playwright

app = FastAPI()


def launch_browser_safe(playwright):
    return playwright.chromium.launch(
        headless=True,
        args=[
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
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
    cookies = {
        '__Secure-next-auth.session-token': inp.session,
        '__Host-next-auth.csrf-token': inp.csrf,
    }
    headers = {
        'accept': '*/*',
        'content-type': 'application/json',
        'origin': 'https://pollo.ai',
        'referer': 'https://pollo.ai/create?target=image-to-image',
        'user-agent': 'Mozilla/5.0',
    }

    s = requests.Session(impersonate='chrome120')
    s.cookies.update(cookies)

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

    create = s.post(
        'https://pollo.ai/api/trpc/image2Image.create?batch=1',
        json=payload,
        headers=headers,
        timeout=60,
    )
    if create.status_code != 200:
        raise HTTPException(status_code=502, detail=f'create HTTP {create.status_code}: {create.text[:240]}')

    try:
        data = create.json()
    except Exception:
        raise HTTPException(status_code=502, detail=f'create non-json: {create.text[:240]}')

    task_id = data[0].get('result', {}).get('data', {}).get('json', {}).get('id')
    if not task_id:
        raise HTTPException(status_code=502, detail='missing task_id')

    for _ in range(40):
        encoded = quote(json.dumps({'0': {'json': {'id': int(task_id)}}}))
        st = s.get(
            f'https://pollo.ai/api/trpc/generation.queryRecordDetail?batch=1&input={encoded}',
            headers={
                'accept': '*/*',
                'origin': 'https://pollo.ai',
                'referer': 'https://pollo.ai/create?target=image-to-image',
                'user-agent': 'Mozilla/5.0',
            },
            timeout=60,
        )
        if st.status_code != 200:
            time.sleep(4)
            continue
        try:
            body = st.json()[0].get('result', {}).get('data', {}).get('json', {})
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
