import { resolveModel } from "./models.js";
import { randomUUID } from "node:crypto";

export type ChatRole = "system" | "user" | "assistant";

export interface ChatAttachment {
  name?: string;
  mimeType?: string;
  dataUrl?: string;
  url?: string;
}

export interface ChatMessage {
  role: ChatRole;
  content: string;
  attachments?: ChatAttachment[];
}

export interface ChatRequestBody {
  model?: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
}

interface OpenAIContentPart {
  type: "text" | "image_url";
  text?: string;
  image_url?: { url: string };
}

const MAX_IMAGE_DATA_URL_CHARS = 7_500_000;
const DEFAULT_MAX_TOKENS_TEXT = 768;
const DEFAULT_MAX_TOKENS_IMAGE = 512;
const RESPONSE_STYLE = [
  "You are a concise assistant.",
  "Reply in Korean unless the user asks for another language.",
  "Keep the answer short, complete, and easy to scan.",
  "Prefer 2 to 5 short sentences or up to 4 bullets.",
  "Do not repeat the user's prompt unless it is needed for clarity.",
  "Avoid long introductions, filler, and extra disclaimers.",
  "If images are attached, start with a one-sentence summary and then give at most 3 short points.",
  "End cleanly with a complete sentence.",
].join(" ");

function getBaseUrl(): string {
  return (process.env.OMLX_BASE_URL?.trim() || "https://feeeld-inc-macbookpro.tail15c8bb.ts.net/v1").replace(/\/+$/, "");
}

function getRootUrl(): string {
  const baseUrl = getBaseUrl();
  return baseUrl.endsWith("/v1") ? baseUrl.slice(0, -3) : baseUrl;
}

function resolveUpstreamUrl(pathEnv: string | undefined, fallbackPath: string): string {
  const path = (pathEnv?.trim() || fallbackPath).startsWith("/")
    ? pathEnv?.trim() || fallbackPath
    : `/${pathEnv?.trim() || fallbackPath}`;
  if (path.startsWith("/v1/")) {
    return `${getRootUrl()}${path}`;
  }
  if (path.startsWith("/api/")) {
    return `${getRootUrl()}${path}`;
  }
  return `${getBaseUrl()}${path}`;
}

function getHeaders(): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const apiKey = process.env.OMLX_API_KEY?.trim();
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  return headers;
}

function normalizeMessages(messages: ChatMessage[]) {
  return messages.map((message) => {
    const parts: OpenAIContentPart[] = [];
    if (message.content.trim()) {
      parts.push({ type: "text", text: message.content });
    }
    for (const attachment of message.attachments || []) {
      const url = attachment.url || attachment.dataUrl;
      if (url && (attachment.mimeType?.startsWith("image/") || url.startsWith("data:image/"))) {
        if (url.startsWith("data:image/") && url.length > MAX_IMAGE_DATA_URL_CHARS) {
          throw Object.assign(
            new Error("Image is too large for the oMLX gateway. Please attach a smaller or compressed image."),
            { status: 413 },
          );
        }
        parts.push({ type: "image_url", image_url: { url } });
      }
    }
    return {
      role: message.role,
      content: parts.length === 1 && parts[0].type === "text" ? parts[0].text || "" : parts,
    };
  });
}

function hasImageAttachments(messages: ChatMessage[]) {
  return messages.some((message) =>
    (message.attachments || []).some((attachment) => {
      const url = attachment.url || attachment.dataUrl || "";
      return Boolean(attachment.mimeType?.startsWith("image/") || url.startsWith("data:image/"));
    }),
  );
}

export function normalizeChatBody(input: ChatRequestBody, stream: boolean) {
  const model = resolveModel(input.model);
  const imageRequest = hasImageAttachments(input.messages || []);
  const defaultMaxTokens = imageRequest ? DEFAULT_MAX_TOKENS_IMAGE : DEFAULT_MAX_TOKENS_TEXT;
  const maxTokens = Number.isFinite(input.maxTokens)
    ? Math.max(1, Math.min(8192, Math.trunc(input.maxTokens || defaultMaxTokens)))
    : defaultMaxTokens;
  const temperature = Number.isFinite(input.temperature) ? Math.max(0, Math.min(2, Number(input.temperature))) : 0.7;
  return {
    model,
    upstreamBody: {
      model: model.upstreamModel,
      messages: [
        { role: "system", content: RESPONSE_STYLE },
        ...normalizeMessages(input.messages || []),
      ],
      temperature,
      max_tokens: maxTokens,
      stream,
    },
  };
}

export async function checkOmlxHealth() {
  const started = Date.now();
  const baseUrl = getBaseUrl();
  const rootUrl = getRootUrl();
  const targets = [`${baseUrl}/models`, `${rootUrl}/api/models`, `${rootUrl}/health`, `${rootUrl}/api/health`];
  const attempts: Array<{ url: string; status: number; ok: boolean; error?: string }> = [];

  for (const url of targets) {
    try {
      const response = await fetch(url, { headers: getHeaders(), signal: AbortSignal.timeout(5000) });
      attempts.push({ url, status: response.status, ok: response.ok });
      if (response.ok) {
        return {
          ok: true,
          status: response.status,
          baseUrl,
          latencyMs: Date.now() - started,
          checkedUrl: url,
          attempts,
        };
      }
    } catch (error) {
      attempts.push({
        url,
        status: 0,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const last = attempts.at(-1);
  return {
    ok: false,
    status: last?.status || 0,
    baseUrl,
    latencyMs: Date.now() - started,
    checkedUrl: last?.url,
    error: last?.error,
    attempts,
  };
}

export async function requestChat(input: ChatRequestBody) {
  const { model } = normalizeChatBody(input, false);
  const started = Date.now();
  const { response } = await requestChatStream(input, AbortSignal.timeout(120000));
  const reader = response.body?.getReader();
  if (!reader) {
    throw Object.assign(new Error("oMLX stream had no response body"), { status: 502 });
  }
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  await consumeSseReader(reader, decoder, {
    onText: (text) => {
      content += text;
    },
  });
  return {
    id: randomUUID(),
    model: model.id,
    upstreamModel: model.upstreamModel,
    latencyMs: Date.now() - started,
    content,
    usage: null,
  };
}

export async function requestChatStream(input: ChatRequestBody, signal?: AbortSignal) {
  const { model, upstreamBody } = normalizeChatBody(input, true);
  const started = Date.now();
  const response = await fetch(resolveUpstreamUrl(process.env.OMLX_CHAT_STREAM_PATH, "/api/chat/stream"), {
    method: "POST",
    headers: getHeaders(),
    body: JSON.stringify({
      ...upstreamBody,
      model: model.upstreamModel,
    }),
    signal,
  });
  if (!response.ok || !response.body) {
    const text = await response.text().catch(() => "");
    throw Object.assign(new Error(text || `oMLX returned HTTP ${response.status}`), { status: response.status });
  }
  return { response, model, started };
}

export async function consumeSseReader(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  decoder: TextDecoder,
  handlers: {
    onText: (text: string) => void;
    onFinish?: (reason: string) => void;
    onMeta?: (data: unknown) => void;
    onUsage?: (data: unknown) => void;
    onWarning?: (data: unknown) => void;
  },
) {
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const blocks = buffer.split("\n\n");
    buffer = blocks.pop() || "";
    for (const block of blocks) {
      let eventName = "";
      const dataLines: string[] = [];
      for (const line of block.split("\n")) {
        if (line.startsWith("event:")) eventName = line.slice(6).trim();
        if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
      }
      for (const raw of dataLines) {
        if (!raw) continue;
        if (raw === "[DONE]") {
          handlers.onFinish?.("stop");
          continue;
        }
        try {
          const chunk = JSON.parse(raw);
          if (eventName === "token" && typeof chunk?.text === "string") {
            handlers.onText(chunk.text);
            continue;
          }
          if (eventName === "meta") {
            handlers.onMeta?.(chunk);
            continue;
          }
          if (eventName === "done") {
            handlers.onFinish?.(chunk?.reason || "stop");
            continue;
          }
          const delta = chunk?.choices?.[0]?.delta?.content;
          if (typeof delta === "string" && delta.length > 0) {
            handlers.onText(delta);
          }
          const finishReason = chunk?.choices?.[0]?.finish_reason;
          if (finishReason) {
            handlers.onFinish?.(finishReason);
          }
          if (chunk?.usage) {
            handlers.onUsage?.(chunk.usage);
          }
        } catch {
          handlers.onWarning?.({ message: "Skipped malformed upstream SSE chunk." });
        }
      }
    }
  }
}
