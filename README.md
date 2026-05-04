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
OMLX_BASE_URL=https://feeeld-inc-macbookpro.tail15c8bb.ts.net/v1
OMLX_API_KEY=
OMLX_DEFAULT_MODEL=gemma-e4b
GATEWAY_PORT=8787
WEB_ORIGIN=http://localhost:5173
```

## API

- `GET /api/health`
- `GET /api/models`
- `POST /api/chat`
- `POST /api/chat/stream`

`gemma-e4b` is enabled first. `gemma-26b-a4b` is visible but unavailable until the Mac runtime is ready.

## GitHub Pages

This repository deploys `apps/web` to GitHub Pages through `.github/workflows/pages.yml`.

```bash
pnpm --filter @maki-llm/web build
git push origin main
gh run watch
```

The deployed page is static. Start `apps/gateway` somewhere reachable from the browser, then set that gateway URL in the status panel.
