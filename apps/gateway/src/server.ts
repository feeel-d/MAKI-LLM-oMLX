import "dotenv/config";
import cors from "cors";
import { randomUUID } from "node:crypto";
import express, { type Request, type Response } from "express";
import { checkOmlxHealth, consumeSseReader, requestChat, requestChatStream, type ChatRequestBody } from "./omlx.js";
import { models } from "./models.js";

const app = express();
const port = Number(process.env.GATEWAY_PORT || 8787);
const webOrigin = process.env.WEB_ORIGIN || "http://localhost:5173";

app.use((_req, res, next) => {
  res.setHeader("Access-Control-Allow-Private-Network", "true");
  next();
});
app.use(cors({ origin: true, credentials: false }));
app.use(express.json({ limit: "25mb" }));

function sendError(res: Response, error: unknown) {
  const err = error as Error & { status?: number };
  res.status(err.status || 500).json({ error: err.message || "Unexpected gateway error" });
}

function writeSse(res: Response, event: string, data: unknown) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

app.get("/api/health", async (_req, res) => {
  const omlx = await checkOmlxHealth();
  res.json({
    ok: omlx.ok,
    service: "maki-llm-omlx-gateway",
    checkedAt: new Date().toISOString(),
    omlx,
    models,
  });
});

app.get("/api/models", (_req, res) => {
  res.json({ models });
});

app.post("/api/chat", async (req: Request<unknown, unknown, ChatRequestBody>, res) => {
  try {
    const result = await requestChat(req.body);
    res.json(result);
  } catch (error) {
    sendError(res, error);
  }
});

app.post("/api/chat/stream", async (req: Request<unknown, unknown, ChatRequestBody>, res) => {
  const abortController = new AbortController();
  req.on("aborted", () => abortController.abort());
  res.on("close", () => {
    if (!res.writableEnded) abortController.abort();
  });

  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  try {
    const { response, model, started } = await requestChatStream(req.body, abortController.signal);
    writeSse(res, "meta", {
      requestId: randomUUID(),
      model: model.id,
      upstreamModel: model.upstreamModel,
      upstreamStatus: response.status,
    });

    const body = response.body;
    if (!body) {
      throw Object.assign(new Error("oMLX stream had no response body"), { status: 502 });
    }
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let didFinish = false;
    await consumeSseReader(reader, decoder, {
      onText: (text) => writeSse(res, "delta", { text }),
      onMeta: (data) => writeSse(res, "upstream_meta", data),
      onUsage: (data) => writeSse(res, "usage", data),
      onWarning: (data) => writeSse(res, "warning", data),
      onFinish: (reason) => {
        didFinish = true;
        writeSse(res, "finish", { reason });
      },
    });

    writeSse(res, "done", { latencyMs: Date.now() - started, finished: didFinish });
    res.end();
  } catch (error) {
    const err = error as Error & { status?: number };
    writeSse(res, "error", { message: err.message || "Gateway stream failed", status: err.status || 500 });
    res.end();
  }
});

app.listen(port, () => {
  console.log(`MAKI LLM oMLX gateway listening on http://localhost:${port}`);
  console.log(`Allowed web origin hint: ${webOrigin}`);
});
