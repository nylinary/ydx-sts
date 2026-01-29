# Minimal Realtime Web Voice Agent (Yandex Cloud)

Одностраничное веб‑приложение (SPA) + небольшой backend‑прокси.

- **Frontend**: `web/index.html` — кнопка «Start/Stop», текстовые логи, захват микрофона через WebAudio.
- **Backend**: `server.py` — раздаёт статику и проксирует WebSocket к Yandex Realtime API.

## Требования
- Python **3.10+**
- API‑ключ сервисного аккаунта и `FOLDER_ID`

## Переменные окружения
См. `.env.sample`:

- `YANDEX_CLOUD_API_KEY`
- `YANDEX_CLOUD_FOLDER_ID`
- (опционально) `YANDEX_REALTIME_MODEL` (по умолчанию `speech-realtime-250923`)
- `PORT` (Railway выставляет сам)

## Локальная установка
Создайте venv и установите зависимости:

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

## Локальный запуск
Вариант 1 — напрямую:

```bash
export YANDEX_CLOUD_API_KEY="<api-key>"
export YANDEX_CLOUD_FOLDER_ID="<folder-id>"
python3 server.py
```

Вариант 2 — через `start.sh`:

```bash
export YANDEX_CLOUD_API_KEY="<api-key>"
export YANDEX_CLOUD_FOLDER_ID="<folder-id>"
./start.sh
```

Откройте в браузере: http://127.0.0.1:8080

## Деплой на Railway
- Добавьте переменные окружения в Railway (**Variables**):
  - `YANDEX_CLOUD_API_KEY`
  - `YANDEX_CLOUD_FOLDER_ID`
  - (опционально) `YANDEX_REALTIME_MODEL`
- Railway задаёт `PORT` автоматически — `server.py` его использует.
- Команда запуска: `./start.sh` (или `python3 server.py`).

## Как это работает
Браузер **не видит** ваш API‑ключ. Он подключается по WebSocket к `GET /ws` на вашем сервере, а сервер уже подключается к Yandex Realtime API и проксирует сообщения.
