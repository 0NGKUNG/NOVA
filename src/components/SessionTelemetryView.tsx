import React, { useEffect, useMemo, useState } from "react";
import {
  Check,
  ChevronDown,
  ChevronRight,
  Circle,
  ExternalLink,
  FileDiff,
  Loader2,
  Undo2,
  XCircle,
} from "lucide-react";
import { AgentSession, FileDiffPreview, FocusGroup, SessionStep } from "../types";
import { Lang } from "../i18n";
import { novaApi } from "../lib/novaClient";
import { getFileBadgeMeta, IdeMarkdown } from "./IdeMarkdown";

interface SessionTelemetryViewProps {
  session: AgentSession;
  lang: Lang;
  compact?: boolean;
}

export function getPhaseLabel(session: AgentSession, lang: Lang): {
  key: string;
  label: string;
} {
  const phase = session.phase || (session.status === "completed" ? "done" : session.status);
  if (session.status === "waiting_approval" || phase === "waiting_approval") {
    return { key: "waiting", label: lang === "th" ? "รออนุมัติ" : "Waiting Approval" };
  }
  if (session.status === "error" || phase === "error") {
    return { key: "error", label: lang === "th" ? "มีข้อผิดพลาด" : "Error" };
  }
  if (session.status === "completed" || phase === "done") {
    return { key: "done", label: lang === "th" ? "เสร็จสิ้น" : "Completed" };
  }
  if (phase === "working") {
    return { key: "working", label: lang === "th" ? "กำลังทำงาน" : "Working" };
  }
  if (phase === "thinking" || session.status === "active") {
    return { key: "thinking", label: lang === "th" ? "กำลังคิด…" : "Thinking…" };
  }
  return { key: "idle", label: lang === "th" ? "พร้อม" : "Idle" };
}

function formatElapsed(startedAt: string, endedAt: string | null | undefined, nowMs: number): string {
  const sMs = Date.parse(startedAt);
  if (!Number.isFinite(sMs)) return "";
  const eMs = endedAt ? Date.parse(endedAt) : nowMs;
  const endValid = Number.isFinite(eMs) ? eMs : nowMs;
  const totalSec = Math.max(1, Math.round((endValid - sMs) / 1000));
  if (totalSec < 60) return `${totalSec}s`;
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return s > 0 ? `${m}m ${s}s` : `${m}m`;
}

function openAt(path: string, line?: number | null) {
  void novaApi.openInEditor(path, line ?? undefined, "antigravity");
}

function formatParentDir(filePath: string): string {
  const normalized = filePath.replace(/\\/g, "/");
  const idx = normalized.lastIndexOf("/");
  if (idx <= 0) return "";
  const dir = normalized.slice(0, idx);
  return dir.startsWith("/") ? dir : `/${dir}`;
}

interface GutterDiffLine {
  kind: "ctx" | "add" | "del" | "sep";
  lineNo: number | null;
  code: string;
}

function parseUnifiedDiffToGutterLines(unifiedDiff: string, fallbackStart?: number | null): GutterDiffLine[] {
  const rawLines = unifiedDiff.split("\n");
  const out: GutterDiffLine[] = [];
  let oldLine = fallbackStart ?? 1;
  let newLine = fallbackStart ?? 1;
  let seenHunk = false;

  for (const raw of rawLines) {
    if (raw.startsWith("--- ") || raw.startsWith("+++ ")) continue;
    const hunkMatch = raw.match(/^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/);
    if (hunkMatch) {
      if (seenHunk && out.length > 0) {
        out.push({ kind: "sep", lineNo: null, code: "⋯" });
      }
      oldLine = Number(hunkMatch[1]);
      newLine = Number(hunkMatch[2]);
      seenHunk = true;
      continue;
    }
    if (raw.startsWith("@@")) continue;

    if (raw.startsWith("+")) {
      out.push({ kind: "add", lineNo: newLine++, code: raw.slice(1) });
    } else if (raw.startsWith("-")) {
      out.push({ kind: "del", lineNo: oldLine++, code: raw.slice(1) });
    } else if (raw.startsWith(" ")) {
      out.push({ kind: "ctx", lineNo: newLine, code: raw.slice(1) });
      oldLine++;
      newLine++;
    } else if (raw.length > 0) {
      out.push({ kind: "ctx", lineNo: newLine++, code: raw });
      oldLine++;
    }
  }
  return out;
}

/** Lightweight syntax token tinting for the dark IDE gutter diff view (matching Antigravity). */
function highlightCodeLine(code: string): React.ReactNode {
  if (!code) return " ";
  const trimmed = code.trimStart();
  if (trimmed.startsWith("//") || trimmed.startsWith("# ")) {
    return <span className="tok-comment">{code}</span>;
  }
  if (trimmed.startsWith("#[")) {
    return <span className="tok-attr">{code}</span>;
  }

  const tokenRe =
    /("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)|\b(fn|pub|let|mut|use|if|else|match|return|async|await|struct|impl|enum|for|in|while|const|export|import|from|interface|type|function|void|true|false|null|None|Some|Ok|Err)\b|\b([A-Z][A-Za-z0-9_]*)\b/g;

  const parts: React.ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  let k = 0;

  while ((m = tokenRe.exec(code)) !== null) {
    if (m.index > last) {
      parts.push(code.slice(last, m.index));
    }
    if (m[1] !== undefined) {
      parts.push(
        <span key={k++} className="tok-str">
          {m[1]}
        </span>
      );
    } else if (m[2] !== undefined) {
      parts.push(
        <span key={k++} className="tok-kw">
          {m[2]}
        </span>
      );
    } else if (m[3] !== undefined) {
      parts.push(
        <span key={k++} className="tok-type">
          {m[3]}
        </span>
      );
    }
    last = m.index + m[0].length;
  }
  if (last < code.length) {
    parts.push(code.slice(last));
  }
  return parts;
}

interface AggregatedFileChange {
  key: string;
  filePath: string;
  fileName: string;
  dirPath: string;
  addedLines: number;
  removedLines: number;
  startLine: number | null;
  canUndo: boolean;
  reverted: boolean;
  gutterLines: GutterDiffLine[];
}

function aggregateSessionDiffs(diffs: FileDiffPreview[]): AggregatedFileChange[] {
  // `session.diffs` stores newest-first; iterate chronological (oldest -> newest)
  const chronological = [...diffs].reverse();
  const byFile = new Map<string, AggregatedFileChange>();

  for (const d of chronological) {
    if (d.addedLines === 0 && d.removedLines === 0 && !d.unifiedDiff.trim()) continue;
    const normKey = d.filePath.replace(/\\/g, "/").toLowerCase();
    const parsedLines = parseUnifiedDiffToGutterLines(d.unifiedDiff, d.startLine);
    const existing = byFile.get(normKey);

    if (!existing) {
      const fileName = d.filePath.split(/[/\\]/).pop() || d.filePath;
      byFile.set(normKey, {
        key: normKey,
        filePath: d.filePath,
        fileName,
        dirPath: formatParentDir(d.filePath),
        addedLines: d.addedLines,
        removedLines: d.removedLines,
        startLine: d.startLine ?? null,
        canUndo: !d.reverted && d.undoTarget != null && d.undoReplacement != null,
        reverted: Boolean(d.reverted),
        gutterLines: parsedLines,
      });
    } else {
      existing.addedLines += d.addedLines;
      existing.removedLines += d.removedLines;
      if (d.startLine && (!existing.startLine || d.startLine < existing.startLine)) {
        existing.startLine = d.startLine;
      }
      existing.canUndo = !d.reverted && d.undoTarget != null && d.undoReplacement != null;
      existing.reverted = Boolean(d.reverted);
      if (parsedLines.length > 0) {
        if (existing.gutterLines.length > 0) {
          existing.gutterLines.push({ kind: "sep", lineNo: null, code: "⋯" });
        }
        existing.gutterLines.push(...parsedLines);
      }
    }
  }

  return Array.from(byFile.values());
}

const StepRow: React.FC<{ st: SessionStep }> = ({ st }) => {
  const [cmdOpen, setCmdOpen] = useState(false);
  const badge = getFileBadgeMeta(st.filePath, st.verb);
  const hasStats = (st.addedLines ?? 0) > 0 || (st.removedLines ?? 0) > 0;
  const isFileLink = Boolean(st.filePath);
  const isExpandableCmd = !isFileLink && st.verb === "Ran" && Boolean(st.detail);

  const handleClick = () => {
    if (isFileLink && st.filePath) {
      openAt(st.filePath, st.startLine);
    } else if (isExpandableCmd) {
      setCmdOpen((v) => !v);
    }
  };

  return (
    <div className="ide-step-wrap">
      <div
        className={`ide-row st-${st.status} ${isFileLink || isExpandableCmd ? "is-link" : ""}`}
        onClick={isFileLink || isExpandableCmd ? handleClick : undefined}
        title={st.filePath ?? st.detail ?? st.summary}
      >
        <span className="ide-verb">{st.verb || "Ran"}</span>
        {st.verb !== "Ran" && <span className={`ide-badge ${badge.cls}`}>{badge.text}</span>}
        <span className="ide-target">{st.summary}</span>
        {st.lineRange && <span className="ide-range">{st.lineRange}</span>}
        {hasStats && (
          <span className="ide-stats">
            <em className="add">+{st.addedLines ?? 0}</em>
            <em className="del">-{st.removedLines ?? 0}</em>
          </span>
        )}
        {isExpandableCmd && (
          <span className="ide-cmd-chev">
            {cmdOpen ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
          </span>
        )}
        <span className="ide-state">
          {st.status === "running" && <Loader2 size={10} className="spin-icon" />}
          {st.status === "waiting" && <span className="step-dot step-dot-waiting" />}
          {st.status === "error" && <XCircle size={10} className="step-icon-error" />}
        </span>
      </div>
      {cmdOpen && st.detail && <code className="ide-cmd-expanded">$ {st.detail}</code>}
    </div>
  );
};

const FocusGroupSection: React.FC<{
  group: FocusGroup;
  isLatest: boolean;
  isLiveSession: boolean;
  nowMs: number;
  maxSteps: number;
}> = ({ group, isLatest, isLiveSession, nowMs, maxSteps }) => {
  const [open, setOpen] = useState<boolean>(isLatest);
  const [userToggled, setUserToggled] = useState(false);

  useEffect(() => {
    if (!userToggled) {
      setOpen(isLatest);
    }
  }, [isLatest, userToggled]);

  const isRunningGroup = isLatest && isLiveSession && !group.endedAt;
  const durationLabel = formatElapsed(group.startedAt, group.endedAt, nowMs);
  const visibleSteps = group.steps.slice(-maxSteps);

  return (
    <div className={`fg-group ${isRunningGroup ? "is-live" : ""} ${open ? "is-open" : ""}`}>
      <button
        type="button"
        className="fg-header"
        onClick={() => {
          setUserToggled(true);
          setOpen((v) => !v);
        }}
      >
        <span className="fg-title">{group.title}</span>
        {durationLabel && <span className="fg-time">{durationLabel}</span>}
        <span className="fg-chevron">
          {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        </span>
      </button>

      {open && visibleSteps.length > 0 && (
        <div className="fg-steps">
          {visibleSteps.map((st) => (
            <StepRow key={st.id} st={st} />
          ))}
        </div>
      )}
    </div>
  );
};

/** 3-Stage Antigravity File Changes Card (Summary Pill -> File List -> Line-Numbered Gutter Diff) */
const FileChangesCard: React.FC<{
  session: AgentSession;
  files: AggregatedFileChange[];
  lang: Lang;
  compact: boolean;
}> = ({ session, files, lang, compact }) => {
  const [listOpen, setListOpen] = useState(false);
  const [openDiffKeys, setOpenDiffKeys] = useState<Record<string, boolean>>({});
  const [undoMsg, setUndoMsg] = useState<string | null>(null);

  const totalAdded = files.reduce((acc, f) => acc + f.addedLines, 0);
  const totalRemoved = files.reduce((acc, f) => acc + f.removedLines, 0);

  const toggleFileDiff = (key: string) => {
    setOpenDiffKeys((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const handleReviewClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    const anyDiffOpen = files.some((f) => openDiffKeys[f.key]);
    if (listOpen && anyDiffOpen) {
      setOpenDiffKeys({});
      setListOpen(false);
      return;
    }
    setListOpen(true);
    const next: Record<string, boolean> = {};
    // Open the first 3 files automatically so Review immediately shows code hunks
    for (const f of files.slice(0, 3)) {
      next[f.key] = true;
    }
    setOpenDiffKeys(next);
  };

  return (
    <div className={`fc-card ${listOpen ? "is-open" : ""}`}>
      {/* Stage 1: Summary Bar (`8 files changed +826 -136 >` + `[ Review ]`) */}
      <div className="fc-summary-bar" onClick={() => setListOpen((v) => !v)}>
        <div className="fc-summary-left">
          <span className="fc-count">
            {files.length}{" "}
            {lang === "th"
              ? "ไฟล์ที่เปลี่ยน"
              : files.length === 1
              ? "file changed"
              : "files changed"}
          </span>
          <span className="ide-stats">
            <em className="add">+{totalAdded}</em>
            <em className="del">-{totalRemoved}</em>
          </span>
          <span className="fc-chev">
            {listOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          </span>
        </div>

        <button type="button" className="fc-review-btn" onClick={handleReviewClick}>
          <FileDiff size={12} />
          <span>{lang === "th" ? "รีวิว" : "Review"}</span>
        </button>
      </div>

      {undoMsg && <div className="ide-note-small fc-undo-msg">{undoMsg}</div>}

      {/* Stage 2: Expanded File Table */}
      {listOpen && (
        <div className="fc-file-list">
          {files.map((f) => {
            const badge = getFileBadgeMeta(f.filePath);
            const diffExpanded = Boolean(openDiffKeys[f.key]);
            const maxGutterLines = compact ? 90 : 180;

            return (
              <div
                key={f.key}
                className={`fc-file-block ${f.reverted ? "is-reverted" : ""}`}
              >
                <div className="fc-file-row" onClick={() => toggleFileDiff(f.key)}>
                  <span className={`ide-badge ${badge.cls}`}>{badge.text}</span>
                  <span className="fc-file-name">{f.fileName}</span>
                  {f.dirPath && <span className="fc-file-dir">{f.dirPath}</span>}

                  <div className="fc-file-right">
                    <span
                      className="fc-row-actions"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <button
                        type="button"
                        className="fc-action-mini"
                        title="Open at changed line in Antigravity IDE"
                        onClick={() => openAt(f.filePath, f.startLine)}
                      >
                        <ExternalLink size={10} /> IDE
                      </button>
                      {f.canUndo && (
                        <button
                          type="button"
                          className="fc-action-mini warn"
                          title="Undo latest edit on this file"
                          onClick={async () => {
                            const r = await novaApi.revertSessionDiff(
                              session.conversationId,
                              f.filePath
                            );
                            setUndoMsg(r.ok ? r.message ?? "Reverted" : r.error ?? "Failed");
                          }}
                        >
                          <Undo2 size={10} /> Undo
                        </button>
                      )}
                    </span>

                    <span className="ide-stats">
                      <em className="add">+{f.addedLines}</em>
                      <em className="del">-{f.removedLines}</em>
                    </span>
                  </div>
                </div>

                {/* Stage 3: Line-Numbered IDE Gutter Diff */}
                {diffExpanded && f.gutterLines.length > 0 && (
                  <div className="fc-gutter-diff">
                    {f.gutterLines.slice(0, maxGutterLines).map((gl, idx) =>
                      gl.kind === "sep" ? (
                        <div key={idx} className="fc-gutter-sep">
                          <span className="fc-ln">⋯</span>
                          <span className="fc-bar" />
                          <span className="fc-code"> </span>
                        </div>
                      ) : (
                        <div
                          key={idx}
                          className={`fc-gutter-row kind-${gl.kind}`}
                          onClick={() => openAt(f.filePath, gl.lineNo ?? f.startLine)}
                          title={`Click to open ${f.fileName}:${gl.lineNo ?? 1} in Antigravity IDE`}
                        >
                          <span className="fc-ln">{gl.lineNo ?? ""}</span>
                          <span className="fc-bar" />
                          <span className="fc-code">{highlightCodeLine(gl.code)}</span>
                        </div>
                      )
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

export const SessionTelemetryView: React.FC<SessionTelemetryViewProps> = ({
  session,
  lang,
  compact = false,
}) => {
  const [planOpen, setPlanOpen] = useState(true);
  const [nowMs, setNowMs] = useState(() => Date.now());

  const isLive = session.status === "active" || session.status === "waiting_approval";

  useEffect(() => {
    if (!isLive) return;
    setNowMs(Date.now());
    const id = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [isLive, session.conversationId]);

  const planSteps = session.planSteps ?? [];
  const doneCount = planSteps.filter((s) => s.status === "done").length;
  const phase = getPhaseLabel(session, lang);

  const groups: FocusGroup[] = (() => {
    if (session.focusGroups && session.focusGroups.length > 0) {
      return session.focusGroups;
    }
    if (session.steps.length > 0) {
      const chrono = session.steps.slice(0, compact ? 10 : 20).reverse();
      return [
        {
          id: "fallback-group",
          title:
            session.currentFocus ||
            (lang === "th" ? "กิจกรรมล่าสุด" : "Explored & edited files"),
          explicitFocus: Boolean(session.currentFocus),
          startedAt: chrono[0]?.timestamp || session.startedAt,
          endedAt: isLive ? null : session.updatedAt,
          steps: chrono,
        },
      ];
    }
    if (isLive && session.currentFocus) {
      return [
        {
          id: "live-focus-init",
          title: session.currentFocus,
          explicitFocus: true,
          startedAt: session.updatedAt || session.startedAt,
          endedAt: null,
          steps: [],
        },
      ];
    }
    return [];
  })();

  const visibleGroups = compact ? groups.slice(-6) : groups.slice(-12);
  const liveNote = isLive ? session.midProcessNote || null : null;
  const renderedMarkdown = session.latestOutput ? session.latestOutput : null;
  const errorText = session.lastError ? session.lastError : null;

  const aggregatedFiles = useMemo(
    () => aggregateSessionDiffs(session.diffs),
    [session.diffs]
  );

  const currentPlanStep =
    planSteps.find((s) => s.status === "in_progress") ??
    planSteps.find((s) => s.status === "failed") ??
    planSteps.find((s) => s.status === "pending") ??
    planSteps[planSteps.length - 1];
  const visiblePlan = planOpen ? planSteps : currentPlanStep ? [currentPlanStep] : [];

  return (
    <div className="ide-stack">
      {/* 1. Prompt */}
      {session.lastUserInput && <div className="ide-prompt">{session.lastUserInput}</div>}

      {/* 2. Plan steps (ONLY if the current turn generated update_steps) */}
      {planSteps.length > 0 && (
        <div
          className={`ide-plan ${planOpen ? "is-open" : "is-collapsed"}`}
          onClick={!planOpen ? () => setPlanOpen(true) : undefined}
        >
          <button
            type="button"
            className="ide-plan-counter"
            onClick={(e) => {
              e.stopPropagation();
              setPlanOpen((v) => !v);
            }}
            title={planOpen ? "Collapse steps" : "Expand steps"}
          >
            {planOpen ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
            <span>
              {doneCount}/{planSteps.length}
            </span>
          </button>
          <div className="ide-plan-list">
            {visiblePlan.map((ps, idx) => (
              <div key={`${idx}-${ps.title}`} className={`ide-plan-row p-${ps.status}`}>
                {ps.status === "done" ? (
                  <Check size={11} className="icon-done" />
                ) : ps.status === "in_progress" ? (
                  <Loader2 size={11} className="icon-running spin-icon" />
                ) : ps.status === "failed" ? (
                  <XCircle size={11} className="icon-error" />
                ) : (
                  <Circle size={9} className="icon-pending" />
                )}
                <span className="ide-plan-title">{ps.title}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 3. Two-Layer Real-Time Process: Topic + Elapsed Timer -> Activity Dropdown */}
      {visibleGroups.length > 0 && (
        <div className="fg-list">
          {visibleGroups.map((grp, idx) => (
            <FocusGroupSection
              key={grp.id}
              group={grp}
              isLatest={idx === visibleGroups.length - 1}
              isLiveSession={isLive}
              nowMs={nowMs}
              maxSteps={compact ? 8 : 18}
            />
          ))}
        </div>
      )}

      {/* 4a. Live mid-process note while running */}
      {liveNote && (
        <div className={`ide-live ${phase.key === "thinking" ? "pulse" : ""}`}>
          <Loader2 size={11} className="spin-icon" />
          <span>{liveNote}</span>
        </div>
      )}

      {/* 4b. Borderless IDE Markdown output (streams live and stays on completion) */}
      {renderedMarkdown && (
        <IdeMarkdown markdown={renderedMarkdown} compact={compact} lang={lang} />
      )}

      {/* 4c. Inline error detail if a headless CLI turn failed */}
      {errorText && (
        <div className="ide-error-box">
          <XCircle size={12} />
          <span>{errorText}</span>
        </div>
      )}

      {/* 5. Antigravity 3-Stage File Changes Card (`8 files changed +826 -136 >` + `[ Review ]`) */}
      {aggregatedFiles.length > 0 && (
        <FileChangesCard
          session={session}
          files={aggregatedFiles}
          lang={lang}
          compact={compact}
        />
      )}
    </div>
  );
};
