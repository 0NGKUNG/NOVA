import React, { useState } from "react";
import { Camera, Send, Square } from "lucide-react";
import { AgentSession, NovaSnapshot, PermissionMode } from "../types";
import { Lang } from "../i18n";
import { novaApi } from "../lib/novaClient";

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

/** Unified bottom bar: Reply (idle) / Steer (running) / Stop. */
export const SessionCockpit: React.FC<CockpitProps> = ({ snapshot, session, lang }) => {
  const [text, setText] = useState("");
  const [snip, setSnip] = useState<string | null>(null);
  const [mode, setMode] = useState<"auto" | "accept-edits" | "plan">("auto");
  const [notice, setNotice] = useState<string | null>(null);

  const running = Boolean(session && (session.status === "active" || session.status === "waiting_approval"));
  const queued = session?.queuedMessages?.length ?? 0;
  const cliOk = snapshot.agyCliAvailable !== false;

  const send = async () => {
    if (!text.trim() && !snip) return;
    const res = await novaApi.sendSessionPrompt({
      workspacePath: session?.workspacePath,
      conversationId: session && !session.conversationId.startsWith("pending-") ? session.conversationId : undefined,
      prompt: text.trim(),
      mode,
      imageDataUrl: snip,
    });
    if (res.ok) {
      setText("");
      setSnip(null);
      setNotice(res.delivery === "queued_hook" ? (lang === "th" ? "ส่งเข้า run ปัจจุบันแล้ว" : "Queued into live run") : null);
    } else {
      setNotice(res.error ?? "Failed");
    }
  };

  return (
    <div className="cockpit">
      {notice && <div className="ide-note-small">{notice}</div>}
      {queued > 0 && <div className="ide-note-small">{queued} queued…</div>}
      <div className="cockpit-row">
        <input
          className="nova-input cockpit-input"
          value={text}
          disabled={!cliOk && !running}
          placeholder={
            running
              ? lang === "th" ? "สั่งเพิ่มระหว่างทำงาน (steer)…" : "Steer the running agent…"
              : lang === "th" ? "ตอบ / สั่งงานต่อ…" : "Reply or continue this session…"
          }
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <button
          className={`ide-mini ${snip ? "on" : ""}`}
          title="Snip screen & let the agent fix what it sees"
          onClick={async () => {
            if (snip) return setSnip(null);
            const r = await novaApi.captureScreenSnip();
            if (r.ok && r.dataUrl) setSnip(r.dataUrl);
          }}
        >
          <Camera size={12} />
        </button>
        {!running && (
          <select className="perm-select" value={mode} onChange={(e) => setMode(e.target.value as typeof mode)}>
            <option value="auto">Auto</option>
            <option value="accept-edits">Accept edits</option>
            <option value="plan">Plan</option>
          </select>
        )}
        <button className="ide-mini primary" onClick={() => void send()} title="Send">
          <Send size={12} />
        </button>
        {running && session && (
          <button
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

/** Start a brand-new headless run in any workspace. */
export const NewRunBar: React.FC<{ snapshot: NovaSnapshot; lang: Lang }> = ({ snapshot, lang }) => {
  const [ws, setWs] = useState("");
  const [prompt, setPrompt] = useState("");
  const [mode, setMode] = useState<"auto" | "accept-edits" | "plan">("auto");
  const [msg, setMsg] = useState<string | null>(null);
  const list = snapshot.recentWorkspaces ?? [];

  const go = async () => {
    if (!prompt.trim()) return;
    const r = await novaApi.sendSessionPrompt({ workspacePath: ws, prompt: prompt.trim(), mode });
    setMsg(r.ok ? null : r.error ?? "Failed");
    if (r.ok) setPrompt("");
  };

  return (
    <div className="cockpit newrun">
      <div className="cockpit-row">
        <select className="perm-select ws-select" value={ws} onChange={(e) => setWs(e.target.value)}>
          <option value="">{lang === "th" ? "เลือกโปรเจกต์…" : "Workspace…"}</option>
          {list.map((w) => (
            <option key={w.path} value={w.path}>
              {w.name}
            </option>
          ))}
        </select>
        <select className="perm-select" value={mode} onChange={(e) => setMode(e.target.value as typeof mode)}>
          <option value="auto">Auto</option>
          <option value="accept-edits">Accept edits</option>
          <option value="plan">Plan</option>
        </select>
      </div>
      <div className="cockpit-row">
        <input
          className="nova-input cockpit-input"
          value={prompt}
          placeholder={lang === "th" ? "สั่งงาน agent ใหม่ (รันเบื้องหลัง)…" : "Start a new agent task (runs in background)…"}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void go()}
        />
        <button className="ide-mini primary" onClick={() => void go()}>
          <Send size={12} />
        </button>
      </div>
      {msg && <div className="ide-note-small">{msg}</div>}
    </div>
  );
};
