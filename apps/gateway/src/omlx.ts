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

function getBaseUrl(): string {
  return (process.env.OMLX_BASE_URL?.trim() || "https://feeeld-inc-macbookpro.tail15c8bb.ts.net/v1").replace(/\/+$/, "");
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
        parts.push({ type: "image_url", image_url: { url } });
      }
    }
    return {
      role: message.role,
      content: parts.length === 1 && parts[0].type === "text" ? parts[0].text || "" : parts,
    };
  });
}

export function normalizeChatBody(input: ChatRequestBody, stream: boolean) {
  const model = resolveModel(input.model);
  const maxTokens = Number.isFinite(input.maxTokens) ? Math.max(1, Math.min(8192, Math.trunc(input.maxTokens || 2048))) : 2048;
  const temperature = Number.isFinite(input.temperature) ? Math.max(0, Math.min(2, Number(input.temperature))) : 0.7;
  return {
    model,
    upstreamBody: {
      model: model.upstreamModel,
      messages: normalizeMessages(input.messages || []),
      temperature,
      max_tokens: maxTokens,
      stream,
    },
  };
}

export async function checkOmlxHealth() {
  const started = Date.now();
  const baseUrl = getBaseUrl();
  const rootUrl = baseUrl.endsWith("/v1") ? baseUrl.slice(0, -3) : baseUrl;
  const targets = [`${baseUrl}/models`, `${rootUrl}/health`, `${rootUrl}/api/health`];
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
  const { model, upstreamBody } = normalizeChatBody(input, false);
  const started = Date.now();
  const response = await fetch(`${getBaseUrl()}/chat/completions`, {
    method: "POST",
    headers: getHeaders(),
    body: JSON.stringify(upstreamBody),
    signal: AbortSignal.timeout(120000),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const message = payload?.error?.message || payload?.message || `oMLX returned HTTP ${response.status}`;
    throw Object.assign(new Error(message), { status: response.status });
  }
  return {
    id: payload?.id || randomUUID(),
    model: model.id,
    upstreamModel: model.upstreamModel,
    latencyMs: Date.now() - started,
    content: payload?.choices?.[0]?.message?.content || "",
    usage: payload?.usage || null,
  };
}

export async function requestChatStream(input: ChatRequestBody, signal?: AbortSignal) {
  const { model, upstreamBody } = normalizeChatBody(input, true);
  const started = Date.now();
  const response = await fetch(`${getBaseUrl()}/chat/completions`, {
    method: "POST",
    headers: getHeaders(),
    body: JSON.stringify(upstreamBody),
    signal,
  });
  if (!response.ok || !response.body) {
    const text = await response.text().catch(() => "");
    throw Object.assign(new Error(text || `oMLX returned HTTP ${response.status}`), { status: response.status });
  }
  return { response, model, started };
}
