export interface GatewayModel {
  id: "gemma-e4b" | "gemma-26b-a4b";
  label: string;
  enabled: boolean;
  reason?: string;
}

export interface Attachment {
  name: string;
  mimeType: string;
  dataUrl: string;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  attachments?: Attachment[];
  status?: "streaming" | "done" | "error";
}

export interface StreamHandlers {
  onMeta?: (data: unknown) => void;
  onDelta: (text: string) => void;
  onDone: (data?: unknown) => void;
  onError: (message: string) => void;
}

export function getDefaultApiBase() {
  return (import.meta.env.VITE_GATEWAY_BASE_URL as string | undefined)?.replace(/\/+$/, "") || "";
}

async function readJson<T>(response: Response): Promise<T> {
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(payload?.error || `HTTP ${response.status}`);
  }
  return payload as T;
}

export async function fetchHealth(apiBase: string) {
  const response = await fetch(`${apiBase}/api/health`);
  return readJson<{
    ok: boolean;
    checkedAt: string;
    omlx?: { ok: boolean; status: number; latencyMs: number; baseUrl: string; error?: string };
  }>(response);
}

export async function fetchModels(apiBase: string) {
  const response = await fetch(`${apiBase}/api/models`);
  return readJson<{ models: GatewayModel[] }>(response);
}

export async function streamChat(params: {
  apiBase: string;
  model: string;
  messages: ChatMessage[];
  signal: AbortSignal;
  handlers: StreamHandlers;
}) {
  const response = await fetch(`${params.apiBase}/api/chat/stream`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: params.model,
      messages: params.messages.map((message) => ({
        role: message.role,
        content: message.content,
        attachments: message.attachments || [],
      })),
    }),
    signal: params.signal,
  });

  if (!response.ok || !response.body) {
    const text = await response.text().catch(() => "");
    throw new Error(text || `HTTP ${response.status}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const events = buffer.split("\n\n");
    buffer = events.pop() || "";
    for (const eventBlock of events) {
      let event = "message";
      const dataLines: string[] = [];
      for (const line of eventBlock.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
      }
      if (dataLines.length === 0) continue;
      const raw = dataLines.join("\n");
      let data: any = raw;
      try {
        data = JSON.parse(raw);
      } catch {
        // Keep raw text.
      }
      if (event === "meta") params.handlers.onMeta?.(data);
      if (event === "delta") params.handlers.onDelta(String(data?.text || ""));
      if (event === "error") params.handlers.onError(String(data?.message || "Stream failed"));
      if (event === "done") params.handlers.onDone(data);
    }
  }
}
