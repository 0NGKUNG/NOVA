import React, { useState } from "react";
import { AlertTriangle, Check, FolderGit2, Pencil, ShieldAlert, ShieldCheck, Terminal, X } from "lucide-react";
import { PendingApproval } from "../types";
import { Lang, t } from "../i18n";
import { novaApi } from "../lib/novaClient";
import { DiffViewer } from "./DiffViewer";

interface ApprovalCardProps {
  approval: PendingApproval;
  lang: Lang;
}

export const ApprovalCard: React.FC<ApprovalCardProps> = ({ approval, lang }) => {
  const risk = approval.risk;
  const riskClass = `risk-badge risk-${risk.level}`;
  const [editing, setEditing] = useState(false);
  const [cmd, setCmd] = useState(approval.commandLine ?? "");
  const [denying, setDenying] = useState(false);
  const [reason, setReason] = useState("");

  return (
    <div className={`nova-approval-card border-risk-${risk.level}`}>
      <div className="nova-approval-top">
        <div className="nova-approval-meta">
          <span className="agent-chip">{approval.agent.toUpperCase()}</span>
          <span className="workspace-chip">
            <FolderGit2 size={12} />
            {approval.workspaceName}
            {approval.gitBranch ? ` (${approval.gitBranch})` : ""}
          </span>
          <span className="tool-chip">{approval.toolName}</span>
        </div>

        <div className={riskClass} title={risk.reasons.join(" • ")}>
          {risk.score >= 60 ? <ShieldAlert size={13} /> : <ShieldCheck size={13} />}
          <span>
            {risk.level.toUpperCase()} ({risk.score})
          </span>
        </div>
      </div>

      {approval.commandLine && !editing && (
        <div className="nova-cmd-preview">
          <Terminal size={13} className="cmd-icon" />
          <code>{approval.commandLine}</code>
        </div>
      )}

      {approval.commandLine && editing && (
        <textarea
          className="nova-textarea approval-edit"
          rows={3}
          value={cmd}
          onChange={(e) => setCmd(e.target.value)}
          spellCheck={false}
        />
      )}

      {approval.targetFile && !approval.commandLine && (
        <div className="nova-cmd-preview">
          <code>{approval.targetFile}</code>
        </div>
      )}

      {risk.reasons.length > 0 && (
        <div className="nova-risk-reasons">
          <AlertTriangle size={12} />
          <span>{risk.reasons.join(" · ")}</span>
        </div>
      )}

      {approval.diffPreview && <DiffViewer diff={approval.diffPreview} compact />}

      {denying && (
        <input
          className="nova-input nova-input-xs"
          autoFocus
          placeholder={lang === "th" ? "บอก agent ว่าควรทำอะไรแทน…" : "Tell the agent what to do instead…"}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") novaApi.resolveApproval(approval.id, "deny", undefined, undefined, reason);
          }}
        />
      )}

      <div className="nova-approval-actions">
        {editing ? (
          <button
            className="nova-btn nova-btn-allow"
            onClick={() => novaApi.resolveApproval(approval.id, "allow", undefined, cmd)}
          >
            <Check size={14} />
            <span>{lang === "th" ? "อนุญาต (แก้แล้ว)" : "Allow Edited"}</span>
          </button>
        ) : (
          <button className="nova-btn nova-btn-allow" onClick={() => novaApi.resolveApproval(approval.id, "allow")}>
            <Check size={14} />
            <span>{t(lang, "allowOnce")}</span>
          </button>
        )}

        {approval.commandLine && (
          <button className="nova-btn nova-btn-ghost" onClick={() => setEditing((v) => !v)}>
            <Pencil size={12} />
            <span>{editing ? (lang === "th" ? "ยกเลิกแก้" : "Cancel edit") : lang === "th" ? "แก้คำสั่ง" : "Edit"}</span>
          </button>
        )}

        <button
          className="nova-btn nova-btn-rule"
          onClick={() => novaApi.resolveApproval(approval.id, "allow", "session")}
          title={
            risk.suggestedRulePattern
              ? `Auto-allow "${risk.suggestedRulePattern}" for this session`
              : "Allow for this session"
          }
        >
          <span>{t(lang, "allowSession")}</span>
        </button>

        <button
          className="nova-btn nova-btn-rule"
          onClick={() => novaApi.resolveApproval(approval.id, "allow", "workspace")}
          title={
            risk.suggestedRulePattern
              ? `Always allow "${risk.suggestedRulePattern}" in ${approval.workspaceName}`
              : "Always allow in this repo"
          }
        >
          <span>{t(lang, "allowRepo")}</span>
        </button>

        <button className="nova-btn nova-btn-ghost" onClick={() => novaApi.resolveApproval(approval.id, "ask")}>
          <span>{t(lang, "askTerminal")}</span>
        </button>

        <button
          className="nova-btn nova-btn-deny"
          onClick={() => {
            if (!denying) setDenying(true);
            else novaApi.resolveApproval(approval.id, "deny", undefined, undefined, reason);
          }}
        >
          <X size={14} />
          <span>{denying && reason ? (lang === "th" ? "ปฏิเสธ + สั่ง" : "Deny + steer") : t(lang, "deny")}</span>
        </button>
      </div>
    </div>
  );
};
