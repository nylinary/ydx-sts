import asyncio
import os
from pathlib import Path

from aiohttp import ClientSession, WSMsgType, web

ROOT = Path(__file__).resolve().parent
WEB_DIR = ROOT / "web"

# ===== Config (from env) =====
YANDEX_CLOUD_API_KEY = os.getenv("YANDEX_CLOUD_API_KEY", "").strip()
YANDEX_CLOUD_FOLDER_ID = os.getenv("YANDEX_CLOUD_FOLDER_ID", "").strip()
MODEL = os.getenv("YANDEX_REALTIME_MODEL", "speech-realtime-250923").strip()
PORT = int(os.getenv("PORT", "8080"))
HOST = os.getenv("HOST", "0.0.0.0")

if not YANDEX_CLOUD_API_KEY or not YANDEX_CLOUD_FOLDER_ID:
    # Don't crash on import; show a clear error on startup.
    pass


def build_ws_url() -> str:
    return (
        "wss://rest-assistant.api.cloud.yandex.net/v1/realtime/openai"
        f"?model=gpt://{YANDEX_CLOUD_FOLDER_ID}/{MODEL}"
    )


async def index(_: web.Request) -> web.Response:
    return web.FileResponse(WEB_DIR / "index.html")


async def health(_: web.Request) -> web.Response:
    return web.json_response({"ok": True})


async def ws_proxy(request: web.Request) -> web.WebSocketResponse:
    if not YANDEX_CLOUD_API_KEY or not YANDEX_CLOUD_FOLDER_ID:
        raise web.HTTPInternalServerError(
            text=(
                "Missing env vars: YANDEX_CLOUD_API_KEY and/or YANDEX_CLOUD_FOLDER_ID. "
                "Set them and restart server."
            )
        )

    client_ws = web.WebSocketResponse(heartbeat=20.0)
    await client_ws.prepare(request)

    headers = {"Authorization": f"api-key {YANDEX_CLOUD_API_KEY}"}

    async with ClientSession() as session:
        upstream = await session.ws_connect(build_ws_url(), headers=headers, heartbeat=20.0)

        async def client_to_upstream():
            async for msg in client_ws:
                if msg.type == WSMsgType.TEXT:
                    await upstream.send_str(msg.data)
                elif msg.type == WSMsgType.BINARY:
                    await upstream.send_bytes(msg.data)
                elif msg.type in (WSMsgType.CLOSE, WSMsgType.CLOSING, WSMsgType.CLOSED):
                    break

        async def upstream_to_client():
            async for msg in upstream:
                if msg.type == WSMsgType.TEXT:
                    await client_ws.send_str(msg.data)
                elif msg.type == WSMsgType.BINARY:
                    await client_ws.send_bytes(msg.data)
                elif msg.type == WSMsgType.ERROR:
                    break

        tasks = [
            asyncio.create_task(client_to_upstream()),
            asyncio.create_task(upstream_to_client()),
        ]

        _done, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
        for t in pending:
            t.cancel()

        try:
            await upstream.close()
        except Exception:
            pass

        try:
            await client_ws.close()
        except Exception:
            pass

    return client_ws


def create_app() -> web.Application:
    app = web.Application()

    # Static (js/css)
    static_dir = WEB_DIR / "static"
    if static_dir.exists():
        app.router.add_static("/static/", path=str(static_dir), name="static")

    app.router.add_get("/", index)
    app.router.add_get("/healthz", health)
    app.router.add_get("/ws", ws_proxy)

    return app


if __name__ == "__main__":
    if not YANDEX_CLOUD_API_KEY or not YANDEX_CLOUD_FOLDER_ID:
        raise SystemExit(
            "Set env vars: YANDEX_CLOUD_API_KEY and YANDEX_CLOUD_FOLDER_ID, then run again."
        )

    web.run_app(create_app(), host=HOST, port=PORT)
