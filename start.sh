#!/usr/bin/env bash
set -euo pipefail

# Minimal startup script for Railway/local.
# Railway обычно задаёт переменные окружения в UI проекта.

if [[ -z "${YANDEX_CLOUD_API_KEY:-}" || -z "${YANDEX_CLOUD_FOLDER_ID:-}" ]]; then
  echo "Missing env vars: YANDEX_CLOUD_API_KEY and/or YANDEX_CLOUD_FOLDER_ID" >&2
  echo "Tip: copy .env.sample to .env and export vars, or set them in Railway." >&2
  exit 1
fi

exec python3 server.py
