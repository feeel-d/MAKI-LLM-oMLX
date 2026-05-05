#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="/Users/markhub/Desktop/workspace/MAKI-LLM-oMLX"
RUNTIME_DIR="${ROOT_DIR}/.runtime"
LLAMA_SERVER="/Users/markhub/llama.cpp/build/bin/llama-server"
MODELS_PRESET="${RUNTIME_DIR}/llama-router-models.ini"
ROUTER_PORT="${ROUTER_PORT:-8081}"

mkdir -p "${RUNTIME_DIR}"

exec "${LLAMA_SERVER}" \
  --models-preset "${MODELS_PRESET}" \
  --models-max 1 \
  --host 127.0.0.1 \
  --port "${ROUTER_PORT}" \
  --parallel 1 \
  --batch-size 512 \
  --ubatch-size 512 \
  --no-webui \
  --metrics
