import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDown,
  Check,
  ChevronDown,
  ChevronRight,
  Circle,
  ExternalLink,
  FileDiff,
  Loader2,
  Terminal,
  Undo2,
  XCircle,
} from "lucide-react";
import { AgentSession, FileDiffPreview, FocusGroup, SessionStep, SessionTurn } from "../types";
import { Lang } from "../i18n";
import { novaApi } from "../lib/novaClient";
import { getFileBadgeMeta, IdeMarkdown, renderMarkdownBlocks } from "./IdeMarkdown";

function formatLiveProcessNote(note: string, lang: Lang): string {
  const trimmed = note.trim();
  const lower = trimmed.toLowerCase();
  if (
    lower.includes("starting antigravity") ||
    lower.includes("warming up") ||
    lower.includes("starting turn") ||
    lower.includes("connecting to agent")
  ) {
    return lang === "th"
      ? "กำลังเริ่มต้น Antigravity CLI และ hooks…"
      : "Initializing workspace & hooks…";
  }
  if (lower.includes("connected — preparing") || lower.includes("connected — waiting")) {
    return lang === "th" ? "เชื่อมต่อแล้ว — กำลังส่งคำสั่ง…" : "Connected — preparing prompt…";
  }
  if (lower.includes("warm session")) {
    return lang === "th" ? "ส่งต่อเข้า session อุ่นแล้ว — กำลังคิด…" : "Warm session — reasoning…";
  }
  if (lower.includes("prompt accepted")) {
    return lang === "th" ? "รับคำสั่งแล้ว — กำลังคิด…" : "Prompt accepted — reasoning…";
  }
  if (lower.includes("generating response")) {
    return lang === "th" ? "กำลังสร้างคำตอบ…" : "Generating response…";
  }
  if (lower.includes("finalizing response")) {
    return lang === "th" ? "กำลังสรุปคำตอบ…" : "Finalizing response…";
  }
  return trimmed;
}

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

function openAt(path: string, line?: number | null, workspacePath?: string | null) {
  void novaApi.openInEditor(
    path,
    line ?? undefined,
    "antigravity",
    workspacePath ?? undefined
  );
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

function normalizePathForDedup(filePath?: string | null): string {
  return (filePath ?? "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

function stepsMatchAction(a: SessionStep, b: SessionStep): boolean {
  if (
    (a.toolName ?? "") !== (b.toolName ?? "") ||
    (a.verb ?? "") !== (b.verb ?? "") ||
    a.summary !== b.summary ||
    (a.lineRange ?? "") !== (b.lineRange ?? "")
  ) {
    return false;
  }
  const pa = normalizePathForDedup(a.filePath);
  const pb = normalizePathForDedup(b.filePath);
  if (pa && pb && pa !== pb) return false;
  if (a.detail && b.detail && a.detail !== b.detail) return false;
  return true;
}

function mergeStepIntoList(dst: SessionStep[], incoming: SessionStep): void {
  if (incoming.callId) {
    const byCallId = dst.find((s) => s.callId === incoming.callId);
    if (byCallId) {
      if (incoming.event !== "Transcript") {
        byCallId.event = incoming.event;
        byCallId.status = incoming.status;
        byCallId.timestamp = incoming.timestamp;
      }
      if (incoming.detail != null) byCallId.detail = incoming.detail;
      if (incoming.filePath != null) byCallId.filePath = incoming.filePath;
      if (incoming.startLine != null) byCallId.startLine = incoming.startLine;
      if (incoming.addedLines != null) {
        byCallId.addedLines = incoming.addedLines;
        byCallId.removedLines = incoming.removedLines;
      }
      if (incoming.unifiedDiff != null) {
        byCallId.unifiedDiff = incoming.unifiedDiff;
      }
      return;
    }

    const trIdx = dst.findIndex(
      (s) => !s.callId && s.event === "Transcript" && stepsMatchAction(s, incoming)
    );
    if (trIdx >= 0) {
      const prevDiff = dst[trIdx].unifiedDiff;
      dst[trIdx] = { ...incoming, unifiedDiff: incoming.unifiedDiff ?? prevDiff };
      return;
    }
  } else if (incoming.event === "Transcript") {
    const hookMatches = dst.filter((s) => Boolean(s.callId) && stepsMatchAction(s, incoming)).length;
    const trMatches = dst.filter(
      (s) => !s.callId && s.event === "Transcript" && stepsMatchAction(s, incoming)
    ).length;
    if (hookMatches > trMatches) {
      if (incoming.unifiedDiff) {
        const match = dst.find(
          (s) => Boolean(s.callId) && !s.unifiedDiff && stepsMatchAction(s, incoming)
        );
        if (match) match.unifiedDiff = incoming.unifiedDiff;
      }
      return;
    }
  }

  if (dst.some((s) => s.id === incoming.id)) return;
  dst.push({ ...incoming });
}

export function deduplicateFocusGroups(rawGroups: FocusGroup[]): FocusGroup[] {
  const out: FocusGroup[] = [];
  for (const grp of rawGroups) {
    const cleanSteps: SessionStep[] = [];
    for (const st of grp.steps) {
      mergeStepIntoList(cleanSteps, st);
    }

    const prev = out[out.length - 1];
    const sameTitle =
      prev && prev.title.trim().toLowerCase() === grp.title.trim().toLowerCase();
    const canCombine = prev && (prev.steps.length === 0 || !grp.preText);

    if (prev && canCombine && (sameTitle || (!prev.explicitFocus && prev.steps.length === 0))) {
      if (grp.explicitFocus) {
        prev.title = grp.title;
        prev.explicitFocus = true;
      }
      if (grp.preText) {
        prev.preText = prev.preText ? `${prev.preText}\n\n${grp.preText}` : grp.preText;
      }
      prev.endedAt = grp.endedAt;
      for (const st of cleanSteps) {
        mergeStepIntoList(prev.steps, st);
      }
    } else {
      out.push({
        ...grp,
        steps: cleanSteps,
      });
    }
  }
  return out;
}

function aggregateSessionDiffs(diffs: FileDiffPreview[]): AggregatedFileChange[] {
  // `session.diffs` stores newest-first; iterate chronological (oldest -> newest)
  const chronological = [...diffs].reverse();
  const byFile = new Map<string, AggregatedFileChange>();
  const seenHunksByFile = new Map<string, Set<string>>();

  for (const d of chronological) {
    if (d.addedLines === 0 && d.removedLines === 0 && !d.unifiedDiff.trim()) continue;
    const normKey = d.filePath.replace(/\\/g, "/").toLowerCase();
    const diffSig = d.unifiedDiff.trim();
    if (!d.reverted && diffSig) {
      let seenSet = seenHunksByFile.get(normKey);
      if (!seenSet) {
        seenSet = new Set<string>();
        seenHunksByFile.set(normKey, seenSet);
      }
      if (seenSet.has(diffSig)) continue;
      seenSet.add(diffSig);
    }
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

const StepRow: React.FC<{
  st: SessionStep;
  turnDiffs: FileDiffPreview[];
  workspacePath: string;
  compact: boolean;
}> = ({ st, turnDiffs, workspacePath, compact }) => {
  const [cmdOpen, setCmdOpen] = useState(false);
  const [diffOpen, setDiffOpen] = useState(false);
  const badge = getFileBadgeMeta(st.filePath, st.verb);
  const hasStats = (st.addedLines ?? 0) > 0 || (st.removedLines ?? 0) > 0;
  const isFileLink = Boolean(st.filePath);
  const isExpandableCmd = !isFileLink && st.verb === "Ran" && Boolean(st.detail);

  const resolvedDiff = useMemo(() => {
    if (st.unifiedDiff && st.unifiedDiff.trim()) return st.unifiedDiff;
    if (st.filePath && hasStats) {
      const targetNorm = st.filePath.replace(/\\/g, "/").toLowerCase();
      const matched = turnDiffs.find(
        (d) => d.filePath.replace(/\\/g, "/").toLowerCase() === targetNorm && d.unifiedDiff.trim()
      );
      if (matched) return matched.unifiedDiff;
    }
    return null;
  }, [st.unifiedDiff, st.filePath, hasStats, turnDiffs]);

  const hasInlineDiff = Boolean(resolvedDiff);
  const gutterLines = useMemo(
    () => (diffOpen && resolvedDiff ? parseUnifiedDiffToGutterLines(resolvedDiff, st.startLine) : []),
    [diffOpen, resolvedDiff, st.startLine]
  );

  const handleRowClick = () => {
    if (hasInlineDiff) {
      setDiffOpen((v) => !v);
    } else if (isExpandableCmd) {
      setCmdOpen((v) => !v);
    } else if (isFileLink && st.filePath) {
      openAt(st.filePath, st.startLine, workspacePath);
    }
  };

  const maxLines = compact ? 70 : 140;

  return (
    <div className={`ide-step-wrap ${diffOpen ? "is-diff-open" : ""}`}>
      <div
        className={`ide-row st-${st.status} ${
          hasInlineDiff || isExpandableCmd || isFileLink ? "is-link" : ""
        }`}
        onClick={hasInlineDiff || isExpandableCmd || isFileLink ? handleRowClick : undefined}
        title={
          hasInlineDiff
            ? "Click to inspect inline diff (or click IDE to jump to workspace line)"
            : st.filePath ?? st.detail ?? st.summary
        }
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
        {(hasInlineDiff || isExpandableCmd) && (
          <span className="ide-cmd-chev">
            {(hasInlineDiff ? diffOpen : cmdOpen) ? (
              <ChevronDown size={11} />
            ) : (
              <ChevronRight size={11} />
            )}
          </span>
        )}
        {isFileLink && st.filePath && (
          <button
            type="button"
            className="ide-step-ide-btn"
            title="Open workspace folder & jump to line in Antigravity IDE"
            onClick={(e) => {
              e.stopPropagation();
              openAt(st.filePath!, st.startLine, workspacePath);
            }}
          >
            <ExternalLink size={9.5} /> IDE
          </button>
        )}
        <span className="ide-state">
          {st.status === "running" && <Loader2 size={10} className="spin-icon" />}
          {st.status === "waiting" && <span className="step-dot step-dot-waiting" />}
          {st.status === "error" && <XCircle size={10} className="step-icon-error" />}
        </span>
      </div>
      {cmdOpen && st.detail && <code className="ide-cmd-expanded">$ {st.detail}</code>}
      {diffOpen && gutterLines.length > 0 && st.filePath && (
        <div className="ide-step-diff">
          <div className="ide-step-diff-bar">
            <span className="ide-step-diff-path">{st.filePath}</span>
            <button
              type="button"
              className="fc-action-mini"
              title="Open project workspace & navigate to changed line in Antigravity IDE"
              onClick={() => openAt(st.filePath!, st.startLine, workspacePath)}
            >
              <ExternalLink size={10} /> Jump to IDE
            </button>
          </div>
          <div className="fc-gutter-diff">
            {gutterLines.slice(0, maxLines).map((gl, idx) =>
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
                  onClick={() => openAt(st.filePath!, gl.lineNo ?? st.startLine, workspacePath)}
                  title={`Click to open ${st.summary}:${gl.lineNo ?? 1} in Antigravity IDE`}
                >
                  <span className="fc-ln">{gl.lineNo ?? ""}</span>
                  <span className="fc-bar" />
                  <span className="fc-code">{highlightCodeLine(gl.code)}</span>
                </div>
              )
            )}
          </div>
        </div>
      )}
    </div>
  );
};

const FocusGroupSection: React.FC<{
  group: FocusGroup;
  isLatest: boolean;
  isLiveSession: boolean;
  nowMs: number;
  compact: boolean;
  lang: Lang;
  workspacePath: string;
  turnDiffs: FileDiffPreview[];
}> = ({ group, isLatest, isLiveSession, nowMs, compact, lang, workspacePath, turnDiffs }) => {
  const isRunningGroup = isLatest && isLiveSession && !group.endedAt;
  // Steps and processes auto-collapse by default. Only open while actively running.
  const [open, setOpen] = useState<boolean>(() => Boolean(isRunningGroup));
  const [userToggled, setUserToggled] = useState(false);
  const wasRunningRef = useRef(isRunningGroup);
  const stepsScrollRef = useRef<HTMLDivElement | null>(null);
  const [stepsScrolledUp, setStepsScrolledUp] = useState(false);

  useEffect(() => {
    // When the process finishes (was running, now completed), auto-collapse all processes!
    if (wasRunningRef.current && !isRunningGroup) {
      setOpen(false);
      setUserToggled(false);
    } else if (!userToggled) {
      setOpen(Boolean(isRunningGroup));
    }
    wasRunningRef.current = isRunningGroup;
  }, [isRunningGroup, userToggled]);

  useEffect(() => {
    if (open && isRunningGroup && !stepsScrolledUp && stepsScrollRef.current) {
      stepsScrollRef.current.scrollTop = stepsScrollRef.current.scrollHeight;
    }
  }, [open, isRunningGroup, stepsScrolledUp, group.steps.length]);

  const durationLabel = formatElapsed(group.startedAt, group.endedAt, nowMs);

  return (
    <>
      {group.preText && (
        <div className="fg-pre-text">
          <IdeMarkdown markdown={group.preText} compact={compact} lang={lang} />
        </div>
      )}
      {group.steps.length > 0 || isRunningGroup ? (
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

          {open && group.steps.length > 0 && (
            <div
              ref={stepsScrollRef}
              className={`fg-steps ${compact ? "is-compact" : ""}`}
              onScroll={(e) => {
                const el = e.currentTarget;
                const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= 24;
                setStepsScrolledUp(!nearBottom);
              }}
            >
              {group.steps.map((st) => (
                <StepRow
                  key={st.id}
                  st={st}
                  turnDiffs={turnDiffs}
                  workspacePath={workspacePath}
                  compact={compact}
                />
              ))}
            </div>
          )}
        </div>
      ) : null}
    </>
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
                        title="Open project workspace & jump to changed line in Antigravity IDE"
                        onClick={() => openAt(f.filePath, f.startLine, session.workspacePath)}
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
                          onClick={() =>
                            openAt(f.filePath, gl.lineNo ?? f.startLine, session.workspacePath)
                          }
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

const PastTurnLogsSection: React.FC<{
  turn: SessionTurn;
  session: AgentSession;
  nowMs: number;
  compact: boolean;
  lang: Lang;
}> = ({ turn, session, nowMs, compact, lang }) => {
  const pastGroups = useMemo(
    () => deduplicateFocusGroups(turn.focusGroups ?? []),
    [turn.focusGroups]
  );
  const pastDiffs = turn.diffs ?? [];
  const pastFiles = useMemo(() => aggregateSessionDiffs(pastDiffs), [pastDiffs]);

  const stepCount = useMemo(() => {
    const counted = pastGroups.reduce((acc, g) => acc + g.steps.length, 0);
    return counted > 0 ? counted : turn.toolCallsCount ?? 0;
  }, [pastGroups, turn.toolCallsCount]);

  const fileCount = pastFiles.length > 0 ? pastFiles.length : turn.filesTouchedCount ?? 0;
  const hasRichLogs = pastGroups.length > 0 || pastFiles.length > 0;
  const hasSummaryBadge = !hasRichLogs && (stepCount > 0 || fileCount > 0);

  if (!hasRichLogs && !hasSummaryBadge && !turn.assistantOutput) {
    return null;
  }

  const summaryLabel =
    lang === "th"
      ? `รันคำสั่งไป ${stepCount} รายการ${fileCount ? ` • แก้ไข ${fileCount} ไฟล์` : ""}`
      : `${stepCount} ${stepCount === 1 ? "tool" : "tools"} executed${
          fileCount ? ` • ${fileCount} ${fileCount === 1 ? "file" : "files"} touched` : ""
        }`;

  return (
    <>
      {hasSummaryBadge && (
        <div className="ide-past-tools-badge">
          <Terminal size={10} />
          <span>{summaryLabel}</span>
        </div>
      )}

      {pastGroups.length > 0 && (
        <div className="fg-list">
          {pastGroups.map((grp, gidx) => (
            <FocusGroupSection
              key={grp.id}
              group={grp}
              isLatest={gidx === pastGroups.length - 1}
              isLiveSession={false}
              nowMs={nowMs}
              compact={compact}
              lang={lang}
              workspacePath={session.workspacePath}
              turnDiffs={pastDiffs}
            />
          ))}
        </div>
      )}

      {turn.assistantOutput && (
        <IdeMarkdown markdown={turn.assistantOutput} compact={compact} lang={lang} />
      )}

      {pastFiles.length > 0 && (
        <FileChangesCard
          session={session}
          files={pastFiles}
          lang={lang}
          compact={compact}
        />
      )}
    </>
  );
};

export function normalizePromptForDisplay(raw: string): string {
  let cur = raw.replace(/\r\n?/g, "\n").trim();
  if (!cur) return "";

  // 1. Strip `<NOVA_HANDOFF_CONTEXT>...</NOVA_HANDOFF_CONTEXT>`
  cur = cur.replace(/^<NOVA_HANDOFF_CONTEXT>[\s\S]*?<\/NOVA_HANDOFF_CONTEXT>\s*/i, "").trim();

  // 2. Strip legacy `[Context from preceding Antigravity IDE session ...]\n\n` prefix
  if (cur.startsWith("[Context from preceding Antigravity IDE session")) {
    const summaryAnchor = Math.max(0, cur.indexOf("Last assistant summary:"));
    const tail = cur.slice(summaryAnchor);
    const dblClose = tail.indexOf("]\n\n");
    if (dblClose >= 0) {
      const after = tail.slice(dblClose + 3).trim();
      if (after) cur = after;
    } else {
      const singleClose = tail.indexOf("]\n");
      if (singleClose >= 0) {
        const after = tail.slice(singleClose + 2).trim();
        if (after) cur = after;
      }
    }
  }

  // 3. Clean NOVA's internal screenshot instruction suffix
  cur = cur.replace(
    /\n\n\[Attached Screenshot:\s*`([^`]+)`\s*—\s*inspect this image file[^\]]*\]$/,
    (_m, fullPath: string) => {
      const base = fullPath.split(/[/\\]/).pop() || "snip.png";
      return `\n\n📎 Attached screenshot: \`${base}\``;
    }
  );

  // 4. Fallback for pre-truncated legacy handoff strings with no trailing prompt
  if (cur.startsWith("[Context from preceding Antigravity IDE session")) {
    cur = cur
      .replace(/^\[/, "")
      .replace(/\]$/, "")
      .replace(/\s*Last user request:\s*/g, "\n**Last user request:** ")
      .replace(/\s*Last assistant summary:\s*/g, "\n**Last assistant summary:** ");
  }

  return cur;
}

const ExpandablePrompt: React.FC<{
  prompt: string;
}> = ({ prompt }) => {
  const formattedPrompt = useMemo(() => normalizePromptForDisplay(prompt), [prompt]);
  const blocks = useMemo(() => renderMarkdownBlocks(formattedPrompt), [formattedPrompt]);

  if (!formattedPrompt) return null;

  return (
    <div className="ide-prompt-wrap">
      <div className="ide-prompt-body">{blocks}</div>
    </div>
  );
};

export const SessionTelemetryView: React.FC<SessionTelemetryViewProps> = ({
  session,
  lang,
  compact = false,
}) => {
  // Steps and processes are auto-collapsed on default
  const [planOpen, setPlanOpen] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());

  const isLive = session.status === "active" || session.status === "waiting_approval";
  const prevLiveRef = useRef(isLive);

  useEffect(() => {
    // When turn/process finishes, auto-collapse plan steps
    if (prevLiveRef.current && !isLive) {
      setPlanOpen(false);
    }
    prevLiveRef.current = isLive;
  }, [isLive]);

  useEffect(() => {
    if (!isLive) return;
    setNowMs(Date.now());
    const id = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [isLive, session.conversationId]);

  const planSteps = session.planSteps ?? [];
  const doneCount = planSteps.filter((s) => s.status === "done").length;
  const phase = getPhaseLabel(session, lang);

  const groups: FocusGroup[] = useMemo(() => {
    if (session.focusGroups && session.focusGroups.length > 0) {
      return deduplicateFocusGroups(session.focusGroups);
    }
    if (session.steps.length > 0) {
      const chrono = [...session.steps].reverse();
      return deduplicateFocusGroups([
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
      ]);
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
  }, [
    session.focusGroups,
    session.steps,
    session.currentFocus,
    session.startedAt,
    session.updatedAt,
    lang,
    isLive,
  ]);

  const visibleGroups = groups;
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

  const effectiveTurns: SessionTurn[] = useMemo(() => {
    if (session.turns && session.turns.length > 0) {
      return session.turns;
    }
    if (session.lastUserInput) {
      return [
        {
          id: "turn-latest",
          userPrompt: session.lastUserInput,
          assistantOutput: session.latestOutput,
          thinking: session.latestThinking,
          modelName: session.modelName,
          toolCallsCount: session.commandsCount,
          filesTouchedCount: session.filesTouchedCount,
          startedAt: session.startedAt,
          completedAt: !isLive ? session.updatedAt : undefined,
          isActive: isLive,
        },
      ];
    }
    return [];
  }, [
    session.turns,
    session.lastUserInput,
    session.latestOutput,
    session.latestThinking,
    session.modelName,
    session.commandsCount,
    session.filesTouchedCount,
    session.startedAt,
    session.updatedAt,
    isLive,
  ]);

  const feedRef = useRef<HTMLDivElement | null>(null);
  const [userScrolledUp, setUserScrolledUp] = useState(false);

  const handleScroll = useCallback(() => {
    const el = feedRef.current;
    if (!el) return;
    const isNearBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= 48;
    setUserScrolledUp(!isNearBottom);
  }, []);

  const scrollToBottom = useCallback(() => {
    const el = feedRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    setUserScrolledUp(false);
  }, []);

  useEffect(() => {
    setUserScrolledUp(false);
    if (feedRef.current) {
      feedRef.current.scrollTop = feedRef.current.scrollHeight;
    }
  }, [session.conversationId]);

  useEffect(() => {
    if (!userScrolledUp && feedRef.current) {
      feedRef.current.scrollTop = feedRef.current.scrollHeight;
    }
  }, [effectiveTurns.length, session.latestOutput, liveNote, userScrolledUp]);

  return (
    <div className="ide-conversation-feed-wrap">
      <div ref={feedRef} className="ide-conversation-feed" onScroll={handleScroll}>
        {effectiveTurns.map((turn, idx) => {
          const isLatest = idx === effectiveTurns.length - 1;
          return (
            <div
              key={turn.id || `turn-${idx}`}
              className={`ide-turn-card ${isLatest ? "is-active-turn" : "is-past-turn"}`}
            >
              {/* Turn divider if there are multiple turns or if it's not turn 0 */}
              {effectiveTurns.length > 1 && (
                <div className="ide-turn-divider">
                  <span className="ide-turn-line" />
                  <span className="ide-turn-tag">
                    {lang === "th" ? `รอบที่ ${idx + 1}` : `Turn ${idx + 1}`}
                    {turn.startedAt
                      ? ` • ${new Date(turn.startedAt).toLocaleTimeString([], {
                          hour: "2-digit",
                          minute: "2-digit",
                        })}`
                      : ""}
                  </span>
                  <span className="ide-turn-line" />
                </div>
              )}

              {/* 1. Prompt (always shown in full inside scrollable feed) */}
              <ExpandablePrompt prompt={turn.userPrompt} />

              {/* Past turn: direct focus-group logs, full assistant response, and file changes card */}
              {!isLatest && (
                <PastTurnLogsSection
                  turn={turn}
                  session={session}
                  nowMs={nowMs}
                  compact={compact}
                  lang={lang}
                />
              )}

              {/* Active / Latest turn: rich live execution components */}
              {isLatest && (
                <>
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
                        {visiblePlan.map((ps, sidx) => (
                          <div key={`${sidx}-${ps.title}`} className={`ide-plan-row p-${ps.status}`}>
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

                  {/* 3. Two-Layer Real-Time Process: Interleaved White Prose + Topic + Scrollable Steps */}
                  {visibleGroups.length > 0 && (
                    <div className="fg-list">
                      {visibleGroups.map((grp, gidx) => (
                        <FocusGroupSection
                          key={grp.id}
                          group={grp}
                          isLatest={gidx === visibleGroups.length - 1}
                          isLiveSession={isLive}
                          nowMs={nowMs}
                          compact={compact}
                          lang={lang}
                          workspacePath={session.workspacePath}
                          turnDiffs={session.diffs}
                        />
                      ))}
                    </div>
                  )}

                  {/* 4a. Minimal single-line live spinner when waiting/reasoning without text */}
                  {!renderedMarkdown && (liveNote || (isLive && visibleGroups.length === 0)) && (
                    <div className={`ide-live ${phase.key === "thinking" || isLive ? "pulse" : ""}`}>
                      <Loader2 size={11} className="spin-icon" />
                      <span>
                        {formatLiveProcessNote(
                          liveNote || (lang === "th" ? "กำลังคิด…" : "Thinking…"),
                          lang
                        )}
                      </span>
                      <span className="ide-live-elapsed">
                        {formatElapsed(turn.startedAt || session.startedAt, null, nowMs)}
                      </span>
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
                </>
              )}
            </div>
          );
        })}
      </div>

      {/* Floating Jump to Latest Button when scrolled up */}
      {userScrolledUp && (
        <button
          type="button"
          className="ide-jump-bottom-btn"
          onClick={scrollToBottom}
          title={lang === "th" ? "เลื่อนไปข้อความล่าสุด" : "Jump to latest response"}
        >
          <ArrowDown size={11} />
          <span>{lang === "th" ? "ข้อความล่าสุด" : "Jump to latest"}</span>
        </button>
      )}
    </div>
  );
};
