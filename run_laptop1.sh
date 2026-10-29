#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"
if [ -f .env.aws ]; then
  set -a
  source .env.aws
  set +a
fi
source .venv/bin/activate
python -m edge_mesh --name Laptop-1 --port 5000 --token demo123
