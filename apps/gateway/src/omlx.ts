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
const DEFAULT_MAX_TOKENS_TEXT = 96;
const DEFAULT_MAX_TOKENS_IMAGE = 192;
type ResponseLanguage = "ko" | "en" | "ja" | "zh" | "ru" | "ar" | "other";

const RESPONSE_STYLE: Record<ResponseLanguage, string> = {
  ko: "Reply in Korean in one short sentence. No markdown. Do not explain reasoning.",
  en: "Reply in English in one short sentence. No markdown. Do not explain reasoning.",
  ja: "Reply in Japanese in one short sentence. No markdown. Do not explain reasoning.",
  zh: "Reply in Simplified Chinese in one short sentence. No markdown. Do not explain reasoning.",
  ru: "Reply in Russian in one short sentence. No markdown. Do not explain reasoning.",
  ar: "Reply in Arabic in one short sentence. No markdown. Do not explain reasoning.",
  other: "Reply in the same language as the user in one short sentence. No markdown. Do not explain reasoning.",
};

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

function countMatches(text: string, regex: RegExp) {
  return (text.match(regex) || []).length;
}

function detectLanguageFromText(text: string): ResponseLanguage {
  const sample = text.trim();
  if (!sample) return "ko";

  const counts: Record<Exclude<ResponseLanguage, "other">, number> = {
    ko: countMatches(sample, /[\uac00-\ud7a3]/g),
    ja: countMatches(sample, /[\u3040-\u30ff]/g),
    zh: countMatches(sample, /[\u4e00-\u9fff]/g),
    ru: countMatches(sample, /[\u0400-\u04ff]/g),
    ar: countMatches(sample, /[\u0600-\u06ff]/g),
    en: countMatches(sample, /[A-Za-z]/g),
  };

  const ranked = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  const [bestLanguage, bestCount] = ranked[0] || ["ko", 0];
  if (bestCount === 0) return "ko";
  if (bestLanguage === "en") {
    const hasOtherScripts = ranked.some(([language, count]) => language !== "en" && count > 0);
    if (hasOtherScripts && bestCount < 4) return "other";
  }
  return bestLanguage as ResponseLanguage;
}

function getLastUserText(messages: ChatMessage[]) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role === "user" && message.content.trim()) {
      return message.content;
    }
  }
  return "";
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
  const lastUserText = getLastUserText(input.messages || []);
  const responseLanguage = detectLanguageFromText(lastUserText);
  const imageRequest = hasImageAttachments(input.messages || []);
  const defaultMaxTokens = imageRequest ? DEFAULT_MAX_TOKENS_IMAGE : DEFAULT_MAX_TOKENS_TEXT;
  const maxTokens = Number.isFinite(input.maxTokens)
    ? Math.max(1, Math.min(8192, Math.trunc(input.maxTokens || defaultMaxTokens)))
    : defaultMaxTokens;
  const temperature = Number.isFinite(input.temperature) ? Math.max(0, Math.min(2, Number(input.temperature))) : 0.2;
  return {
    model,
    upstreamBody: {
      model: model.upstreamModel,
      messages: [
        { role: "system", content: RESPONSE_STYLE[responseLanguage] },
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

export function startKeepWarmLoop() {
  const enabled = (process.env.OMLX_KEEP_WARM_ENABLED || "true").toLowerCase() !== "false";
  if (!enabled) return;

  const intervalMs = Math.max(10_000, Number(process.env.OMLX_KEEP_WARM_INTERVAL_MS || 30_000));
  const prompt = process.env.OMLX_KEEP_WARM_PROMPT || "ok";

  async function warmOnce() {
    const started = Date.now();
    try {
      const { response } = await requestChatStream(
        {
          model: process.env.OMLX_DEFAULT_MODEL || "gemma-e4b",
          messages: [{ role: "user", content: prompt }],
          maxTokens: 4,
          temperature: 0,
        },
        AbortSignal.timeout(Math.min(20_000, intervalMs - 1_000)),
      );
      const reader = response.body?.getReader();
      if (reader) {
        await consumeSseReader(reader, new TextDecoder(), { onText: () => undefined });
      }
      console.log(`oMLX keep-warm completed in ${Date.now() - started}ms`);
    } catch (error) {
      console.warn(`oMLX keep-warm failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  setTimeout(() => void warmOnce(), 2_000);
  setInterval(() => void warmOnce(), intervalMs);
  console.log(`oMLX keep-warm enabled every ${intervalMs}ms`);
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
