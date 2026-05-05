# MAKI LLM oMLX Web Chat

Fast web-only chat UI and Node gateway for an oMLX OpenAI-compatible server.

## Local

```bash
pnpm install
cp .env.example apps/gateway/.env
pnpm dev
```

- Web: http://localhost:5173
- Gateway: http://localhost:8787

The web app can also run from GitHub Pages. Because Pages is static, set the gateway URL in the UI when testing a deployed page.

## Gateway env

```bash
OMLX_BASE_URL=http://127.0.0.1:8081/v1
OMLX_API_KEY=
OMLX_DEFAULT_MODEL=gemma-e4b
OMLX_CHAT_STREAM_PATH=/v1/chat/completions
OMLX_KEEP_WARM_ENABLED=true
OMLX_KEEP_WARM_INTERVAL_MS=30000
OMLX_KEEP_WARM_PROMPT=ok
GATEWAY_PORT=8787
WEB_ORIGIN=http://localhost:5173
```

## API

- `GET /api/health`
- `GET /api/models`
- `POST /api/chat`
- `POST /api/chat/stream`

`gemma-e4b` is enabled first. `gemma-26b-a4b` is visible but unavailable until the Mac runtime is ready.

Use `POST /api/chat/stream` for the fastest perceived responses because it returns tokens as soon as the upstream model starts generating. The gateway defaults are tuned for short summaries; pass `maxTokens` when a longer answer is needed.

## GitHub Pages

This repository deploys `apps/web` to GitHub Pages through `.github/workflows/pages.yml`.

```bash
pnpm --filter @maki-llm/web build
git push origin main
gh run watch
```

The deployed page is static. Start `apps/gateway` somewhere reachable from the browser, then set that gateway URL in the status panel.

Current tested gateway URL:

```text
https://feeeld-inc-macbookpro.tail15c8bb.ts.net:8443
```

It is exposed through Tailscale Funnel on port `8443`, forwarding to the local gateway on `127.0.0.1:8787`.
