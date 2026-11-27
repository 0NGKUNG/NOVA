import React, { useState } from "react";
import { Check, FolderGit2, Send, ShieldAlert, X } from "lucide-react";
import { NovaSnapshot } from "../types";
import { novaApi } from "../lib/novaClient";
import { NovaOrb } from "../components/NovaOrb";
import { QuestionCard } from "../components/QuestionCard";
import { DiffViewer } from "../components/DiffViewer";
import { renderMarkdownBlocks } from "../components/IdeMarkdown";

interface MobilePwaSurfaceProps {
  snapshot: NovaSnapshot;
}

export const MobilePwaSurface: React.FC<MobilePwaSurfaceProps> = ({ snapshot }) => {
  const [tab, setTab] = useState<"approvals" | "sessions" | "chat">("approvals");
  const [prompt, setPrompt] = useState("");
  const activeCount = snapshot.sessions.filter((s) => s.status === "active").length;
  const pendingQuestions = snapshot.pendingQuestions ?? [];
  const totalWaiting = snapshot.pendingApprovals.length + pendingQuestions.length;
  const thread = snapshot.threads[0];

  return (
    <div className="nova-mobile-pwa">
      <header className="mobile-header">
        <div className="nova-row-gap">
          <NovaOrb
            mode="orb"
            aura={snapshot.settings.aura}
            state={totalWaiting > 0 ? "alert" : "active"}
            size={34}
          />
          <div>
            <div className="nova-logo-text">NOVA Mobile Link</div>
            <div className="muted-note">
              {totalWaiting} waiting · {activeCount} active
            </div>
          </div>
        </div>
      </header>

      <nav className="mobile-tabs">
        <button
          className={tab === "approvals" ? "active" : ""}
          onClick={() => setTab("approvals")}
        >
          Approvals ({totalWaiting})
        </button>
        <button
          className={tab === "sessions" ? "active" : ""}
          onClick={() => setTab("sessions")}
        >
          Workspaces ({snapshot.sessions.length})
        </button>
        <button className={tab === "chat" ? "active" : ""} onClick={() => setTab("chat")}>
          AI Chat
        </button>
      </nav>

      <main className="mobile-main">
        {tab === "approvals" && (
          <div className="mobile-stack">
            {pendingQuestions.map((pq) => (
              <QuestionCard
                key={pq.id}
                pending={pq}
                lang={snapshot.settings.language}
                sttProvider={snapshot.settings.sttProvider}
                compact
              />
            ))}
            {snapshot.pendingApprovals.length === 0 && pendingQuestions.length === 0 ? (
              <div className="nova-empty-card">All clear — no pending approvals or questions on your PC.</div>
            ) : (
              snapshot.pendingApprovals.map((a) => (
                <div key={a.id} className="nova-approval-card">
                  <div className="nova-row-between">
                    <strong>
                      <FolderGit2 size={14} /> {a.workspaceName}
                    </strong>
                    <span className={`risk-badge risk-${a.risk.level}`}>
                      <ShieldAlert size={12} /> {a.risk.level.toUpperCase()}
                    </span>
                  </div>
                  <div className="nova-cmd-preview">
                    <code>{a.commandLine || a.targetFile || a.toolName}</code>
                  </div>
                  {a.diffPreview && <DiffViewer diff={a.diffPreview} compact />}
                  <div className="mobile-btn-row">
                    <button
                      className="nova-btn nova-btn-allow"
                      onClick={() => novaApi.resolveApproval(a.id, "allow")}
                    >
                      <Check size={16} /> Allow
                    </button>
                    <button
                      className="nova-btn nova-btn-rule"
                      onClick={() => novaApi.resolveApproval(a.id, "allow", "workspace")}
                    >
                      Always in Repo
                    </button>
                    <button
                      className="nova-btn nova-btn-deny"
                      onClick={() => novaApi.resolveApproval(a.id, "deny")}
                    >
                      <X size={16} /> Deny
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
        )}

        {tab === "sessions" && (
          <div className="mobile-stack">
            {snapshot.sessions.map((s) => (
              <div key={s.conversationId} className="hub-card">
                <div className="nova-row-between">
                  <strong>{s.workspaceName}</strong>
                  <span className="agent-chip">{s.status}</span>
                </div>
                <div className="muted-note">
                  {s.gitBranch || "main"} · {s.commandsCount} cmds · {s.filesTouchedCount} edits
                </div>
                {s.diffs[0] && <DiffViewer diff={s.diffs[0]} compact />}
              </div>
            ))}
          </div>
        )}

        {tab === "chat" && (
          <div className="mobile-stack">
            <div className="nova-chat-messages">
              {thread?.messages.map((m) => (
                <div key={m.id} className={`chat-bubble role-${m.role}`}>
                  {m.role === "assistant" ? (
                    <div className="chat-md-body">{renderMarkdownBlocks(m.content)}</div>
                  ) : (
                    m.content
                  )}
                </div>
              ))}
            </div>
            <div className="nova-chat-Compose">
              <input
                className="nova-input"
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder="Message NOVA on your PC..."
              />
              <button
                className="nova-btn nova-btn-primary"
                onClick={async () => {
                  if (!prompt.trim()) return;
                  const txt = prompt;
                  setPrompt("");
                  await novaApi.sendChat({
                    threadId: thread?.id ?? "thread-main",
                    content: txt,
                  });
                }}
              >
                <Send size={15} />
              </button>
            </div>
          </div>
        )}
      </main>
    </div>
  );
};
