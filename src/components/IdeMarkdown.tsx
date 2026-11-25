import React, { useState } from "react";
import { ChevronDown, ChevronUp, Copy, Check } from "lucide-react";
import { novaApi } from "../lib/novaClient";
import { Lang } from "../i18n";

export function getFileBadgeMeta(path?: string | null, verb?: string): { text: string; cls: string } {
  if (verb === "Ran") return { text: ">_", cls: "b-shell" };
  if (!path) return { text: "•", cls: "b-misc" };
  const clean = path.split("#")[0] || path;
  const ext = (clean.split(".").pop() || "").toLowerCase();
  const map: Record<string, [string, string]> = {
    rs: ["Rs", "b-rs"],
    ts: ["TS", "b-ts"],
    tsx: ["⚛", "b-ts"],
    js: ["JS", "b-js"],
    jsx: ["⚛", "b-js"],
    css: ["{}", "b-css"],
    md: ["M↓", "b-md"],
    json: ["{}", "b-json"],
    toml: ["TM", "b-json"],
    html: ["<>", "b-css"],
    py: ["Py", "b-ts"],
  };
  const hit = map[ext];
  return hit ? { text: hit[0], cls: hit[1] } : { text: ext.slice(0, 3).toUpperCase() || "•", cls: "b-misc" };
}

function parseFileUriTarget(href: string): { filePath: string; line?: number } | null {
  if (!href.startsWith("file://")) return null;
  try {
    const withoutScheme = href.replace(/^file:\/\/\/?/, "");
    const [rawPath, hashPart] = withoutScheme.split("#");
    const decoded = decodeURIComponent(rawPath);
    const normalized = /^[a-zA-Z]:/.test(decoded) ? decoded : `/${decoded}`;
    let line: number | undefined;
    if (hashPart) {
      const m = hashPart.match(/^L(\d+)/i);
      if (m) line = Number(m[1]);
    }
    return { filePath: normalized, line };
  } catch {
    return null;
  }
}

function renderInlineCodeContent(code: string): React.ReactNode {
  const diffStatMatch = code.match(/^(.*?)(\+\d+)\s+(-\d+)(.*)$/);
  if (diffStatMatch) {
    return (
      <>
        {diffStatMatch[1]}
        <span className="md-stat-add">{diffStatMatch[2]}</span>{" "}
        <span className="md-stat-del">{diffStatMatch[3]}</span>
        {diffStatMatch[4]}
      </>
    );
  }
  return code;
}

function renderInlineTokens(text: string, keyPrefix: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  // Matches: [label](url), `code`, **bold**
  const tokenRe = /\[([^\]]+)\]\(([^)]+)\)|`([^`]+)`|\*\*([^*]+)\*\*/g;
  let lastIdx = 0;
  let match: RegExpExecArray | null;
  let part = 0;

  while ((match = tokenRe.exec(text)) !== null) {
    if (match.index > lastIdx) {
      nodes.push(text.slice(lastIdx, match.index));
    }
    const k = `${keyPrefix}-${part++}`;
    if (match[1] !== undefined && match[2] !== undefined) {
      const label = match[1];
      const url = match[2].trim();
      const fileTarget = parseFileUriTarget(url);
      if (fileTarget) {
        const badge = getFileBadgeMeta(fileTarget.filePath);
        nodes.push(
          <button
            key={k}
            type="button"
            className="md-file-chip"
            onClick={() =>
              void novaApi.openInEditor(fileTarget.filePath, fileTarget.line, "antigravity")
            }
            title={
              fileTarget.line
                ? `${fileTarget.filePath}:${fileTarget.line}`
                : fileTarget.filePath
            }
          >
            <span className={`ide-badge ${badge.cls}`}>{badge.text}</span>
            <span>{label}</span>
          </button>
        );
      } else if (url.startsWith("http://") || url.startsWith("https://")) {
        nodes.push(
          <button
            key={k}
            type="button"
            className="md-ext-link"
            onClick={() => void novaApi.openExternalUrl(url)}
          >
            {label}
          </button>
        );
      } else {
        nodes.push(<code key={k} className="md-code-inline">{label}</code>);
      }
    } else if (match[3] !== undefined) {
      nodes.push(
        <code key={k} className="md-code-inline">
          {renderInlineCodeContent(match[3])}
        </code>
      );
    } else if (match[4] !== undefined) {
      nodes.push(<strong key={k} className="md-strong">{match[4]}</strong>);
    }
    lastIdx = match.index + match[0].length;
  }

  if (lastIdx < text.length) {
    nodes.push(text.slice(lastIdx));
  }
  return nodes;
}

const CodeFenceBlock: React.FC<{ langLabel: string; code: string }> = ({ langLabel, code }) => {
  const [copied, setCopied] = useState(false);
  return (
    <div className="md-fence">
      <div className="md-fence-bar">
        <span>{langLabel || "code"}</span>
        <button
          type="button"
          className="md-copy-btn"
          onClick={() => {
            void novaApi.copyToClipboard(code);
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1400);
          }}
        >
          {copied ? <Check size={10} /> : <Copy size={10} />}
          <span>{copied ? "Copied" : "Copy"}</span>
        </button>
      </div>
      <pre className="md-fence-pre">{code}</pre>
    </div>
  );
};

interface IdeMarkdownProps {
  markdown: string;
  compact?: boolean;
  lang: Lang;
}

export const IdeMarkdown: React.FC<IdeMarkdownProps> = ({ markdown, compact = false, lang }) => {
  const [expanded, setExpanded] = useState(false);
  const trimmed = markdown.trim();
  if (!trimmed) return null;

  const lines = trimmed.split("\n");
  const isLong = compact && (trimmed.length > 560 || lines.length > 10);

  const blocks: React.ReactNode[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const t = line.trim();

    if (!t) {
      i++;
      continue;
    }

    // Fenced code block
    if (t.startsWith("```")) {
      const fenceLang = t.slice(3).trim();
      const buf: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith("```")) {
        buf.push(lines[i]);
        i++;
      }
      if (i < lines.length) i++;
      blocks.push(<CodeFenceBlock key={`fence-${i}`} langLabel={fenceLang} code={buf.join("\n")} />);
      continue;
    }

    // Horizontal rule
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(t)) {
      blocks.push(<hr key={`hr-${i}`} className="md-hr" />);
      i++;
      continue;
    }

    // Headings
    const headingMatch = t.match(/^(#{1,4})\s+(.+)$/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      blocks.push(
        <div key={`h-${i}`} className={`md-heading md-h${level}`}>
          {renderInlineTokens(headingMatch[2], `h-${i}`)}
        </div>
      );
      i++;
      continue;
    }

    // List items (ordered & unordered, preserving sub-indent)
    const listMatch = line.match(/^(\s*)(?:([-*•])|(\d+)\.)\s+(.+)$/);
    if (listMatch) {
      const items: Array<{ indent: number; marker: string; body: string; key: string }> = [];
      while (i < lines.length) {
        const m = lines[i].match(/^(\s*)(?:([-*•])|(\d+)\.)\s+(.+)$/);
        if (!m) break;
        items.push({
          indent: Math.min(2, Math.floor((m[1]?.length ?? 0) / 2)),
          marker: m[3] ? `${m[3]}.` : "•",
          body: m[4],
          key: `li-${i}`,
        });
        i++;
      }
      blocks.push(
        <div key={`list-${i}`} className="md-list">
          {items.map((it) => (
            <div key={it.key} className={`md-list-row indent-${it.indent}`}>
              <span className="md-list-marker">{it.marker}</span>
              <span className="md-list-body">{renderInlineTokens(it.body, it.key)}</span>
            </div>
          ))}
        </div>
      );
      continue;
    }

    // Paragraph
    blocks.push(
      <p key={`p-${i}`} className="md-para">
        {renderInlineTokens(t, `p-${i}`)}
      </p>
    );
    i++;
  }

  return (
    <div className="ide-md-wrap">
      <div className={`ide-md-body ${isLong && !expanded ? "is-clamped" : ""}`}>{blocks}</div>
      {isLong && (
        <button
          type="button"
          className="ide-md-toggle"
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? (
            <>
              <ChevronUp size={11} />
              <span>{lang === "th" ? "ย่อคำตอบ" : "Collapse response"}</span>
            </>
          ) : (
            <>
              <ChevronDown size={11} />
              <span>{lang === "th" ? "อ่านคำตอบเต็ม" : "Show full response"}</span>
            </>
          )}
        </button>
      )}
    </div>
  );
};
