import argparse
import json
import sys
import time
from urllib.parse import quote

from curl_cffi import requests


def fail(message: str):
    print(json.dumps({"ok": False, "error": message}), flush=True)
    sys.exit(1)


def post_json(session, url, payload, headers):
    resp = session.post(url, json=payload, headers=headers, timeout=60)
    return resp


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--session", required=True)
    parser.add_argument("--csrf", required=True)
    parser.add_argument("--prompt", required=True)
    parser.add_argument("--image-url", required=True)
    args = parser.parse_args()

    cookies = {
        "__Secure-next-auth.session-token": args.session,
        "__Host-next-auth.csrf-token": args.csrf,
    }

    headers = {
        "accept": "*/*",
        "content-type": "application/json",
        "origin": "https://pollo.ai",
        "referer": "https://pollo.ai/create?target=image-to-image",
        "user-agent": "Mozilla/5.0",
    }

    session = requests.Session(impersonate="chrome120")
    session.cookies.update(cookies)

    payload = {
        "0": {
            "json": {
                "projectId": "cmof6s7i904jdoguj5o8pxnqi",
                "entryCode": "ImageToImage",
                "modelName": "openai-gpt-image-2-0",
                "imageUrl": args.image_url,
                "images": [args.image_url],
                "prompt": args.prompt,
                "aspectRatio": "9:16",
                "resolution": "1K",
                "quality": "medium",
                "numOutputs": 1,
                "mode": "standard",
                "outputFormat": "png",
                "outputQuality": 80,
                "enableTranslatePrompt": False,
                "enableMagicPrompt": False,
                "published": True,
                "protectionMode": False,
                "resourceObj": {"resource_type": ""},
            }
        }
    }

    create_url = "https://pollo.ai/api/trpc/image2Image.create?batch=1"
    create_resp = post_json(session, create_url, payload, headers)
    if create_resp.status_code != 200:
        fail(f"create HTTP {create_resp.status_code}: {create_resp.text[:240]}")

    try:
        create_data = create_resp.json()
    except Exception:
        fail(f"create non-json: {create_resp.text[:240]}")

    task_id = create_data[0].get("result", {}).get("data", {}).get("json", {}).get("id")
    if not task_id:
        fail("missing task_id")

    for _ in range(40):
        inp = quote(json.dumps({"0": {"json": {"id": int(task_id)}}}))
        status_url = f"https://pollo.ai/api/trpc/generation.queryRecordDetail?batch=1&input={inp}"
        st = session.get(status_url, headers={"accept": "*/*", "origin": "https://pollo.ai", "referer": "https://pollo.ai/create?target=image-to-image", "user-agent": "Mozilla/5.0"}, timeout=60)
        if st.status_code != 200:
            time.sleep(4)
            continue
        try:
            body = st.json()[0].get("result", {}).get("data", {}).get("json", {})
        except Exception:
            time.sleep(4)
            continue
        status = str(body.get("status", "")).lower()
        outputs = body.get("images") or body.get("outputImages") or body.get("imageUrls") or body.get("outputs") or []
        image_url = None
        if isinstance(outputs, list):
            image_url = next((x for x in outputs if isinstance(x, str) and x.startswith("http")), None)

        if image_url:
            print(json.dumps({"ok": True, "task_id": str(task_id), "image_url": image_url}), flush=True)
            return
        if "fail" in status:
            fail(body.get("failMsg") or "generation failed")
        time.sleep(4)

    print(json.dumps({"ok": True, "task_id": str(task_id), "image_url": None, "timeout": True}), flush=True)


if __name__ == "__main__":
    main()