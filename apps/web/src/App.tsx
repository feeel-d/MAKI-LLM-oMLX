import { ClipboardEvent, FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { Attachment, ChatMessage, fetchHealth, fetchModels, GatewayModel, getDefaultApiBase, streamChat } from "./api";

const welcome: ChatMessage = {
  id: "welcome",
  role: "assistant",
  content: "oMLX gateway에 연결해서 Gemma E4B로 대화를 시작하세요. GitHub Pages에서는 Gateway URL을 먼저 지정하면 됩니다.",
  status: "done",
};

function uid() {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

const MAX_IMAGE_EDGE = 1280;
const JPEG_QUALITY = 0.78;

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error || new Error("Failed to read image"));
    reader.readAsDataURL(file);
  });
}

function loadImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Failed to decode image"));
    image.src = dataUrl;
  });
}

async function fileToDataUrl(file: File): Promise<Attachment> {
  const sourceUrl = await readFileAsDataUrl(file);
  const image = await loadImage(sourceUrl);
  const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(image.naturalWidth, image.naturalHeight));
  const width = Math.max(1, Math.round(image.naturalWidth * scale));
  const height = Math.max(1, Math.round(image.naturalHeight * scale));

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) {
    return { name: file.name, mimeType: file.type || "image/png", dataUrl: sourceUrl };
  }
  context.drawImage(image, 0, 0, width, height);
  const dataUrl = canvas.toDataURL("image/jpeg", JPEG_QUALITY);
  const safeName = file.name.replace(/\.[^.]+$/, "") || "image";
  return { name: `${safeName}.jpg`, mimeType: "image/jpeg", dataUrl };
}

function uniqueImageFiles(files: File[]) {
  const seen = new Set<string>();
  return files.filter((file) => {
    const key = `${file.name}:${file.size}:${file.type}:${file.lastModified}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function GatewayPanel({
  apiBase,
  onApiBaseChange,
  health,
  healthDetail,
  onCheck,
  compact = false,
}: {
  apiBase: string;
  onApiBaseChange: (value: string) => void;
  health: string;
  healthDetail: string;
  onCheck: () => void;
  compact?: boolean;
}) {
  return (
    <div className={`panel-card gateway-panel ${compact ? "compact" : ""}`}>
      <div className="status-line">
        <span className={`dot ${health}`} />
        <strong>{health}</strong>
        <button type="button" onClick={onCheck}>
          Check
        </button>
      </div>
      <label>Gateway URL</label>
      <input value={apiBase} onChange={(event) => onApiBaseChange(event.target.value)} placeholder="http://localhost:8787" />
      <p>{healthDetail || "Gateway status is not checked yet."}</p>
      {compact ? null : <p>GitHub Pages is static. Use a reachable gateway URL here.</p>}
    </div>
  );
}

export function App() {
  const [apiBase, setApiBase] = useState(() => localStorage.getItem("maki-omlx-api-base") || getDefaultApiBase());
  const [theme, setTheme] = useState<"light" | "dark">(() => (localStorage.getItem("maki-omlx-theme") as "light" | "dark") || "dark");
  const [models, setModels] = useState<GatewayModel[]>([]);
  const [model, setModel] = useState("gemma-e4b");
  const [health, setHealth] = useState<string>("checking");
  const [healthDetail, setHealthDetail] = useState<string>("");
  const [messages, setMessages] = useState<ChatMessage[]>([welcome]);
  const [input, setInput] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  const normalizedApiBase = useMemo(() => apiBase.replace(/\/+$/, ""), [apiBase]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("maki-omlx-theme", theme);
  }, [theme]);

  useEffect(() => {
    localStorage.setItem("maki-omlx-api-base", normalizedApiBase);
  }, [normalizedApiBase]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [messages, attachments]);

  async function refreshGateway() {
    setHealth("checking");
    setHealthDetail("");
    try {
      const [healthResult, modelResult] = await Promise.all([fetchHealth(normalizedApiBase), fetchModels(normalizedApiBase)]);
      setModels(modelResult.models);
      setHealth(healthResult.ok ? "online" : "offline");
      setHealthDetail(
        healthResult.omlx
          ? `${healthResult.omlx.baseUrl} · HTTP ${healthResult.omlx.status} · ${healthResult.omlx.latencyMs}ms${healthResult.omlx.error ? ` · ${healthResult.omlx.error}` : ""}`
          : healthResult.checkedAt,
      );
    } catch (error) {
      setHealth("offline");
      setHealthDetail(error instanceof Error ? error.message : String(error));
    }
  }

  useEffect(() => {
    void refreshGateway();
  }, []);

  async function addFiles(files: FileList | File[]) {
    const images = uniqueImageFiles([...files].filter((file) => file.type.startsWith("image/")));
    if (images.length === 0) return;
    const converted = await Promise.all(images.slice(0, 4).map(fileToDataUrl));
    setAttachments((prev) => [...prev, ...converted].slice(0, 4));
  }

  async function handlePaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    const files = uniqueImageFiles([
      ...Array.from(event.clipboardData.files).filter((file) => file.type.startsWith("image/")),
      ...Array.from(event.clipboardData.items)
        .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
        .map((item) => item.getAsFile())
        .filter((file): file is File => Boolean(file)),
    ]);
    if (files.length === 0) return;
    event.preventDefault();
    await addFiles(files);
  }

  async function handleSubmit(event?: FormEvent) {
    event?.preventDefault();
    const text = input.trim();
    if ((!text && attachments.length === 0) || isStreaming) return;

    const userMessage: ChatMessage = {
      id: uid(),
      role: "user",
      content: text,
      attachments,
      status: "done",
    };
    const assistantId = uid();
    const assistantMessage: ChatMessage = {
      id: assistantId,
      role: "assistant",
      content: "",
      status: "streaming",
    };

    setMessages((prev) => [...prev, userMessage, assistantMessage]);
    setInput("");
    setAttachments([]);
    setIsStreaming(true);

    const abort = new AbortController();
    abortRef.current = abort;
    try {
      await streamChat({
        apiBase: normalizedApiBase,
        model,
        messages: [...messages.filter((item) => item.id !== "welcome"), userMessage],
        signal: abort.signal,
        handlers: {
          onDelta(text) {
            setMessages((prev) => prev.map((item) => (item.id === assistantId ? { ...item, content: item.content + text } : item)));
          },
          onDone() {
            setMessages((prev) => prev.map((item) => (item.id === assistantId ? { ...item, status: "done" } : item)));
          },
          onError(message) {
            setMessages((prev) =>
              prev.map((item) =>
                item.id === assistantId ? { ...item, content: item.content || message, status: "error" } : item,
              ),
            );
          },
        },
      });
    } catch (error) {
      if (!abort.signal.aborted) {
        const message = error instanceof Error ? error.message : String(error);
        setMessages((prev) => prev.map((item) => (item.id === assistantId ? { ...item, content: message, status: "error" } : item)));
      }
    } finally {
      setIsStreaming(false);
      abortRef.current = null;
    }
  }

  function stopStream() {
    abortRef.current?.abort();
    setIsStreaming(false);
  }

  function retryLast() {
    const lastUser = [...messages].reverse().find((item) => item.role === "user");
    if (!lastUser || isStreaming) return;
    setInput(lastUser.content);
    setAttachments(lastUser.attachments || []);
  }

  const selectedModel = models.find((item) => item.id === model);

  return (
    <main
      className={`shell ${isDragging ? "dragging" : ""}`}
      onDragOver={(event) => {
        event.preventDefault();
        setIsDragging(true);
      }}
      onDragLeave={() => setIsDragging(false)}
      onDrop={(event) => {
        event.preventDefault();
        setIsDragging(false);
        void addFiles(event.dataTransfer.files);
      }}
    >
      <section className="chat">
        <header className="topbar">
          <div>
            <p className="eyebrow">MAKI LLM oMLX</p>
            <h1>Gemma Web Chat</h1>
          </div>
          <div className="top-actions">
            <select value={model} onChange={(event) => setModel(event.target.value)} aria-label="Model">
              {(models.length ? models : [{ id: "gemma-e4b", label: "Gemma E4B", enabled: true } as GatewayModel]).map((item) => (
                <option key={item.id} value={item.id} disabled={!item.enabled}>
                  {item.label}{item.enabled ? "" : " · unavailable"}
                </option>
              ))}
            </select>
            <button className="icon-button" type="button" onClick={() => setTheme(theme === "dark" ? "light" : "dark")}>
              {theme === "dark" ? "Light" : "Dark"}
            </button>
          </div>
        </header>

        <div className="messages" aria-live="polite">
          {messages.map((message) => (
            <article key={message.id} className={`message ${message.role} ${message.status || ""}`}>
              <div className="bubble">
                {message.attachments && message.attachments.length > 0 ? (
                  <div className="inline-images">
                    {message.attachments.map((attachment) => (
                      <img key={attachment.dataUrl} src={attachment.dataUrl} alt={attachment.name} />
                    ))}
                  </div>
                ) : null}
                <p>{message.content || (message.status === "streaming" ? "Thinking..." : "")}</p>
              </div>
            </article>
          ))}
          <div ref={bottomRef} />
        </div>

        <div className="mobile-status-panel">
          <GatewayPanel
            compact
            apiBase={apiBase}
            onApiBaseChange={setApiBase}
            health={health}
            healthDetail={healthDetail}
            onCheck={refreshGateway}
          />
        </div>

        <form className="composer" onSubmit={handleSubmit}>
          {attachments.length > 0 ? (
            <div className="preview-strip">
              {attachments.map((attachment, index) => (
                <button
                  key={attachment.dataUrl}
                  type="button"
                  className="preview"
                  onClick={() => setAttachments((prev) => prev.filter((_, i) => i !== index))}
                  title="Remove image"
                >
                  <img src={attachment.dataUrl} alt={attachment.name} />
                </button>
              ))}
            </div>
          ) : null}
          <div className="composer-row">
            <label className="file-button">
              Image
              <input type="file" accept="image/*" multiple onChange={(event) => event.target.files && void addFiles(event.target.files)} />
            </label>
            <textarea
              value={input}
              onChange={(event) => setInput(event.target.value)}
              placeholder="Ask Gemma E4B..."
              rows={1}
              onPaste={(event) => {
                void handlePaste(event);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  void handleSubmit();
                }
              }}
            />
            {isStreaming ? (
              <button type="button" className="send danger" onClick={stopStream}>
                Stop
              </button>
            ) : (
              <button type="submit" className="send">
                Send
              </button>
            )}
          </div>
        </form>
      </section>

      <aside className="status-panel">
        <GatewayPanel apiBase={apiBase} onApiBaseChange={setApiBase} health={health} healthDetail={healthDetail} onCheck={refreshGateway} />
        <div className="panel-card">
          <strong>{selectedModel?.label || "Gemma E4B"}</strong>
          <p>{selectedModel?.reason || "Enabled model routed to the oMLX OpenAI-compatible API."}</p>
          <button type="button" onClick={retryLast} disabled={isStreaming}>
            Retry last prompt
          </button>
        </div>
      </aside>
    </main>
  );
}
