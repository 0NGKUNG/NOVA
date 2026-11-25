import React, { useEffect, useRef, useState } from "react";
import { Camera, ImagePlus, Send, Square, X } from "lucide-react";
import { AGY_CLI_MODELS, AgentSession, NovaSnapshot, PermissionMode } from "../types";
import { Lang } from "../i18n";
import { novaApi } from "../lib/novaClient";

const MAX_IMAGES = 8;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const IMAGE_EXT_RE = /\.(png|jpe?g|webp|gif|bmp)$/i;

export interface AttachedImageItem {
  id: string;
  dataUrl: string;
  name: string;
}

export function isSupportedImageFile(file: File): boolean {
  return file.type.startsWith("image/") || IMAGE_EXT_RE.test(file.name || "");
}

export function fileToDataUrl(file: File): Promise<string | null> {
  if (!isSupportedImageFile(file) || file.size <= 0 || file.size > MAX_IMAGE_BYTES) {
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : null);
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(file);
  });
}

async function filesToAttachedImages(files: Iterable<File>): Promise<AttachedImageItem[]> {
  const out: AttachedImageItem[] = [];
  let idx = 0;
  for (const f of files) {
    if (out.length >= MAX_IMAGES) break;
    const dataUrl = await fileToDataUrl(f);
    if (dataUrl) {
      idx += 1;
      const fallbackExt = f.type.split("/")[1]?.replace("jpeg", "jpg") || "png";
      out.push({
        id: `img-${Date.now()}-${idx}-${Math.random().toString(36).slice(2, 7)}`,
        dataUrl,
        name: f.name?.trim() || `pasted-${idx}.${fallbackExt}`,
      });
    }
  }
  return out;
}

function autoResizeTextarea(el: HTMLTextAreaElement | null) {
  if (!el) return;
  el.style.height = "auto";
  el.style.height = `${Math.min(112, Math.max(30, el.scrollHeight))}px`;
}

function extractImageFilesFromClipboard(dt: DataTransfer | null): File[] {
  if (!dt) return [];
  const collected: File[] = [];
  if (dt.items && dt.items.length > 0) {
    for (let i = 0; i < dt.items.length; i += 1) {
      const item = dt.items[i];
      if (item.kind === "file") {
        const f = item.getAsFile();
        if (f && isSupportedImageFile(f)) collected.push(f);
      }
    }
  }
  if (collected.length === 0 && dt.files && dt.files.length > 0) {
    for (let i = 0; i < dt.files.length; i += 1) {
      const f = dt.files[i];
      if (isSupportedImageFile(f)) collected.push(f);
    }
  }
  return collected;
}

const AttachmentStrip: React.FC<{
  images: AttachedImageItem[];
  onRemove: (id: string) => void;
}> = ({ images, onRemove }) => {
  if (images.length === 0) return null;
  return (
    <div className="cockpit-attachments">
      {images.map((img) => (
        <div key={img.id} className="cockpit-thumb-card" title={img.name}>
          <img src={img.dataUrl} alt={img.name} className="cockpit-thumb-img" />
          <span className="cockpit-thumb-name">{img.name}</span>
          <button
            type="button"
            className="cockpit-thumb-remove"
            onClick={() => onRemove(img.id)}
            title="Remove image"
          >
            <X size={11} />
          </button>
        </div>
      ))}
    </div>
  );
};

export const PERMISSION_OPTIONS: Array<{ id: PermissionMode; label: string; hint: string }> = [
  { id: "follow_agy", label: "Follow AGY", hint: "Antigravity decides (Turbo / Auto / Default). No extra popups." },
  { id: "turbo", label: "Turbo ⚡", hint: "Allow everything without asking." },
  { id: "smart_auto", label: "Smart 🛡️", hint: "Auto-allow safe commands, ask for risky ones." },
  { id: "request_review", label: "Review 👁️", hint: "Ask in NOVA for every command." },
];

export const PermissionPill: React.FC<{ snapshot: NovaSnapshot; session?: AgentSession | null }> = ({
  snapshot,
  session,
}) => {
  const global = (snapshot.settings.permissionMode ?? "follow_agy") as PermissionMode;
  const current = ((session?.permissionOverride as PermissionMode | null) || global) as PermissionMode;
  const ide = session?.detectedIdePermission || snapshot.detectedIdePermission;
  return (
    <div className="perm-pill" title={PERMISSION_OPTIONS.find((o) => o.id === current)?.hint}>
      <select
        className="perm-select"
        value={current}
        onChange={(e) => {
          const v = e.target.value as PermissionMode;
          void novaApi.setPermissionMode({
            globalMode: v,
            conversationId: session?.conversationId,
            sessionOverride: session ? "" : undefined,
          });
        }}
      >
        {PERMISSION_OPTIONS.map((o) => (
          <option key={o.id} value={o.id}>
            {o.label}
          </option>
        ))}
      </select>
      {current === "follow_agy" && ide && <span className="perm-ide">IDE: {ide}</span>}
    </div>
  );
};

interface CockpitProps {
  snapshot: NovaSnapshot;
  session: AgentSession | null;
  lang: Lang;
}

/** Unified bottom bar: Reply (idle) / Steer (running) / Stop + Image Paste/Upload/Snip. */
export const SessionCockpit: React.FC<CockpitProps> = ({ snapshot, session, lang }) => {
  const [text, setText] = useState("");
  const [images, setImages] = useState<AttachedImageItem[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [mode, setMode] = useState<"auto" | "accept-edits" | "plan">("auto");
  const [model, setModel] = useState<string>("");
  const [notice, setNotice] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    setModel("");
  }, [session?.conversationId]);

  const running = Boolean(session && (session.status === "active" || session.status === "waiting_approval"));
  const queued = session?.queuedMessages?.length ?? 0;
  const cliOk = snapshot.agyCliAvailable !== false;

  const appendImages = (incoming: AttachedImageItem[]) => {
    if (incoming.length === 0) return;
    setImages((prev) => [...prev, ...incoming].slice(0, MAX_IMAGES));
  };

  const handlePaste = async (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const pastedFiles = extractImageFilesFromClipboard(e.clipboardData);
    if (pastedFiles.length > 0) {
      e.preventDefault();
      const loaded = await filesToAttachedImages(pastedFiles);
      appendImages(loaded);
      return;
    }

    const plain = e.clipboardData?.getData("text/plain") ?? "";
    if (!plain) {
      e.preventDefault();
      const cb = await novaApi.readClipboardImage();
      if (cb.ok && cb.dataUrl) {
        appendImages([
          {
            id: `cb-${Date.now()}`,
            dataUrl: cb.dataUrl,
            name: cb.name || "clipboard.png",
          },
        ]);
      }
    }
  };

  const send = async () => {
    if (!text.trim() && images.length === 0) return;
    const res = await novaApi.sendSessionPrompt({
      workspacePath: session?.workspacePath,
      conversationId:
        session && (running || !session.conversationId.startsWith("pending-"))
          ? session.conversationId
          : undefined,
      prompt: text.trim(),
      mode,
      model: model || null,
      imageDataUrl: images[0]?.dataUrl ?? null,
      images: images.map((img) => ({ dataUrl: img.dataUrl, name: img.name })),
    });
    if (res.ok) {
      setText("");
      if (inputRef.current) inputRef.current.style.height = "30px";
      setImages([]);
      setNotice(res.delivery === "queued_hook" ? (lang === "th" ? "ส่งเข้า run ปัจจุบันแล้ว" : "Queued into live run") : null);
    } else {
      setNotice(res.error ?? "Failed");
    }
  };

  return (
    <div
      className={`cockpit ${dragOver ? "is-dragover" : ""}`}
      onDragOver={(e) => {
        if (e.dataTransfer?.types?.includes("Files")) {
          e.preventDefault();
          e.stopPropagation();
          setDragOver(true);
        }
      }}
      onDragLeave={(e) => {
        e.stopPropagation();
        setDragOver(false);
      }}
      onDrop={async (e) => {
        e.preventDefault();
        e.stopPropagation();
        setDragOver(false);
        if (e.dataTransfer?.files?.length) {
          const loaded = await filesToAttachedImages(Array.from(e.dataTransfer.files));
          appendImages(loaded);
        }
      }}
    >
      {notice && <div className="ide-note-small">{notice}</div>}
      {queued > 0 && <div className="ide-note-small">{queued} queued…</div>}
      <AttachmentStrip
        images={images}
        onRemove={(id) => setImages((prev) => prev.filter((item) => item.id !== id))}
      />
      <input
        ref={fileInputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif,image/bmp,image/*"
        multiple
        hidden
        onChange={async (e) => {
          const list = e.target.files ? Array.from(e.target.files) : [];
          e.target.value = "";
          if (list.length > 0) {
            const loaded = await filesToAttachedImages(list);
            appendImages(loaded);
          }
        }}
      />
      {!running && (
        <div className="cockpit-row">
          <select
            className="perm-select model-select"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            title={lang === "th" ? "เลือกรุ่นโมเดลสำหรับรอบถัดไป" : "Model for next turn"}
          >
            <option value="">{lang === "th" ? "Model: ปัจจุบัน" : "Model: Current"}</option>
            {AGY_CLI_MODELS.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
          <select className="perm-select" value={mode} onChange={(e) => setMode(e.target.value as typeof mode)}>
            <option value="auto">Auto</option>
            <option value="accept-edits">Accept edits</option>
            <option value="plan">Plan</option>
          </select>
        </div>
      )}
      <div className="cockpit-row">
        <textarea
          ref={inputRef}
          rows={1}
          className="nova-textarea cockpit-input"
          value={text}
          disabled={!cliOk && !running}
          placeholder={
            running
              ? lang === "th"
                ? "สั่งเพิ่ม / Ctrl+V วางรูป… (Shift+Enter ขึ้นบรรทัดใหม่)"
                : "Steer running agent or Ctrl+V paste image… (Shift+Enter new line)"
              : lang === "th"
                ? "ตอบ / สั่งงานต่อ / Ctrl+V วางรูป…"
                : "Reply, continue, or Ctrl+V paste image…"
          }
          onChange={(e) => {
            setText(e.target.value);
            autoResizeTextarea(e.currentTarget);
          }}
          onPaste={(e) => void handlePaste(e)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <button
          type="button"
          className={`ide-mini ${images.length > 0 ? "on" : ""}`}
          title={lang === "th" ? "อัปโหลดรูปภาพ (หรือกด Ctrl+V วางรูป)" : "Upload image (or Ctrl+V paste / drag & drop)"}
          onClick={() => {
            fileInputRef.current?.click();
          }}
        >
          <ImagePlus size={12} />
        </button>
        <button
          type="button"
          className="ide-mini"
          title={lang === "th" ? "แคปหน้าจอแนบส่งให้ Agent" : "Snip screen & attach screenshot"}
          onClick={async () => {
            const r = await novaApi.captureScreenSnip();
            if (r.ok && r.dataUrl) {
              appendImages([
                {
                  id: `snip-${Date.now()}`,
                  dataUrl: r.dataUrl,
                  name: `screen-${new Date().toTimeString().slice(0, 8).replace(/:/g, "")}.png`,
                },
              ]);
            }
          }}
        >
          <Camera size={12} />
        </button>
        <button type="button" className="ide-mini primary" onClick={() => void send()} title="Send">
          <Send size={12} />
        </button>
        {running && session && (
          <button
            type="button"
            className="ide-mini danger"
            title="Stop this run"
            onClick={() => void novaApi.stopSession(session.conversationId)}
          >
            <Square size={11} /> Stop
          </button>
        )}
      </div>
      {!cliOk && !running && <div className="ide-note-small">agy.exe not found — reply works only while a run is active.</div>}
    </div>
  );
};

/** Start a brand-new headless run in any workspace (supports text + images). */
export const NewRunBar: React.FC<{ snapshot: NovaSnapshot; lang: Lang }> = ({ snapshot, lang }) => {
  const [ws, setWs] = useState("");
  const [prompt, setPrompt] = useState("");
  const [images, setImages] = useState<AttachedImageItem[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [mode, setMode] = useState<"auto" | "accept-edits" | "plan">("auto");
  const [model, setModel] = useState<string>(() => {
    try {
      return localStorage.getItem("nova_newrun_model") || "gemini-4-carbon-low";
    } catch {
      return "gemini-4-carbon-low";
    }
  });
  const [msg, setMsg] = useState<string | null>(null);
  const newRunInputRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const list = snapshot.recentWorkspaces ?? [];

  const appendImages = (incoming: AttachedImageItem[]) => {
    if (incoming.length === 0) return;
    setImages((prev) => [...prev, ...incoming].slice(0, MAX_IMAGES));
  };

  const handlePaste = async (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const pastedFiles = extractImageFilesFromClipboard(e.clipboardData);
    if (pastedFiles.length > 0) {
      e.preventDefault();
      const loaded = await filesToAttachedImages(pastedFiles);
      appendImages(loaded);
      return;
    }

    const plain = e.clipboardData?.getData("text/plain") ?? "";
    if (!plain) {
      e.preventDefault();
      const cb = await novaApi.readClipboardImage();
      if (cb.ok && cb.dataUrl) {
        appendImages([
          {
            id: `cb-${Date.now()}`,
            dataUrl: cb.dataUrl,
            name: cb.name || "clipboard.png",
          },
        ]);
      }
    }
  };

  const go = async () => {
    if (!prompt.trim() && images.length === 0) return;
    const r = await novaApi.sendSessionPrompt({
      workspacePath: ws,
      prompt: prompt.trim(),
      mode,
      model: model || null,
      imageDataUrl: images[0]?.dataUrl ?? null,
      images: images.map((img) => ({ dataUrl: img.dataUrl, name: img.name })),
    });
    setMsg(r.ok ? null : r.error ?? "Failed");
    if (r.ok) {
      setPrompt("");
      setImages([]);
      if (newRunInputRef.current) newRunInputRef.current.style.height = "30px";
    }
  };

  return (
    <div
      className={`cockpit newrun ${dragOver ? "is-dragover" : ""}`}
      onDragOver={(e) => {
        if (e.dataTransfer?.types?.includes("Files")) {
          e.preventDefault();
          e.stopPropagation();
          setDragOver(true);
        }
      }}
      onDragLeave={(e) => {
        e.stopPropagation();
        setDragOver(false);
      }}
      onDrop={async (e) => {
        e.preventDefault();
        e.stopPropagation();
        setDragOver(false);
        if (e.dataTransfer?.files?.length) {
          const loaded = await filesToAttachedImages(Array.from(e.dataTransfer.files));
          appendImages(loaded);
        }
      }}
    >
      <div className="cockpit-row">
        <select className="perm-select ws-select" value={ws} onChange={(e) => setWs(e.target.value)}>
          <option value="">{lang === "th" ? "เลือกโปรเจกต์…" : "Workspace…"}</option>
          {list.map((w) => (
            <option key={w.path} value={w.path}>
              {w.name}
            </option>
          ))}
        </select>
        <select
          className="perm-select model-select"
          value={model}
          onChange={(e) => {
            const v = e.target.value;
            setModel(v);
            try {
              localStorage.setItem("nova_newrun_model", v);
            } catch {}
          }}
          title={lang === "th" ? "โมเดลสำหรับรันใหม่" : "Model for new run"}
        >
          <option value="">{lang === "th" ? "CLI Default" : "CLI Default"}</option>
          {AGY_CLI_MODELS.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </select>
        <select className="perm-select" value={mode} onChange={(e) => setMode(e.target.value as typeof mode)}>
          <option value="auto">Auto</option>
          <option value="accept-edits">Accept edits</option>
          <option value="plan">Plan</option>
        </select>
      </div>
      <AttachmentStrip
        images={images}
        onRemove={(id) => setImages((prev) => prev.filter((item) => item.id !== id))}
      />
      <input
        ref={fileInputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif,image/bmp,image/*"
        multiple
        hidden
        onChange={async (e) => {
          const listFiles = e.target.files ? Array.from(e.target.files) : [];
          e.target.value = "";
          if (listFiles.length > 0) {
            const loaded = await filesToAttachedImages(listFiles);
            appendImages(loaded);
          }
        }}
      />
      <div className="cockpit-row">
        <textarea
          ref={newRunInputRef}
          rows={1}
          className="nova-textarea cockpit-input"
          value={prompt}
          placeholder={
            lang === "th"
              ? "สั่งงาน agent ใหม่ / Ctrl+V วางรูป (Shift+Enter ขึ้นบรรทัดใหม่)…"
              : "Start a new agent task or Ctrl+V paste image (Shift+Enter new line)…"
          }
          onChange={(e) => {
            setPrompt(e.target.value);
            autoResizeTextarea(e.currentTarget);
          }}
          onPaste={(e) => void handlePaste(e)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void go();
            }
          }}
        />
        <button
          type="button"
          className={`ide-mini ${images.length > 0 ? "on" : ""}`}
          title={lang === "th" ? "อัปโหลดรูปภาพ (หรือกด Ctrl+V วางรูป)" : "Upload image (or Ctrl+V paste / drag & drop)"}
          onClick={() => {
            fileInputRef.current?.click();
          }}
        >
          <ImagePlus size={12} />
        </button>
        <button
          type="button"
          className="ide-mini"
          title={lang === "th" ? "แคปหน้าจอแนบส่งให้ Agent" : "Snip screen & attach screenshot"}
          onClick={async () => {
            const r = await novaApi.captureScreenSnip();
            if (r.ok && r.dataUrl) {
              appendImages([
                {
                  id: `snip-${Date.now()}`,
                  dataUrl: r.dataUrl,
                  name: `screen-${new Date().toTimeString().slice(0, 8).replace(/:/g, "")}.png`,
                },
              ]);
            }
          }}
        >
          <Camera size={12} />
        </button>
        <button type="button" className="ide-mini primary" onClick={() => void go()}>
          <Send size={12} />
        </button>
      </div>
      {msg && <div className="ide-note-small">{msg}</div>}
    </div>
  );
};
