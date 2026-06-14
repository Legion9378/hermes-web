#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
exec python3 serve.py --host 127.0.0.1 --port "${PORT:-4173}"
