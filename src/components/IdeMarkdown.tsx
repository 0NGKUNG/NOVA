import React, { useState } from "react";
import { Copy, Check } from "lucide-react";
import { novaApi } from "../lib/novaClient";
import { Lang } from "../i18n";
import { AgentEmbedWidget, normalizeEmbedSrcPath } from "./AgentEmbedWidget";

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

interface InlineToken {
  type: "text" | "bold" | "italic" | "bold_italic" | "code" | "del" | "link" | "url";
  text?: string;
  label?: string;
  url?: string;
}

export function tokenizeInline(input: string): InlineToken[] {
  const tokens: InlineToken[] = [];
  let i = 0;
  const len = input.length;

  while (i < len) {
    // 1. Links: [label](url)
    if (input[i] === "[") {
      const closeBracket = input.indexOf("]", i + 1);
      if (closeBracket !== -1 && input[closeBracket + 1] === "(") {
        const closeParen = input.indexOf(")", closeBracket + 2);
        if (closeParen !== -1) {
          const label = input.slice(i + 1, closeBracket);
          const url = input.slice(closeBracket + 2, closeParen);
          tokens.push({ type: "link", label, url });
          i = closeParen + 1;
          continue;
        }
      }
    }

    // 2. Inline code: `code`
    if (input[i] === "`") {
      const closeTick = input.indexOf("`", i + 1);
      if (closeTick !== -1) {
        const code = input.slice(i + 1, closeTick);
        tokens.push({ type: "code", text: code });
        i = closeTick + 1;
        continue;
      }
    }

    // 3. Strikethrough: ~~del~~
    if (input.startsWith("~~", i)) {
      const closeDel = input.indexOf("~~", i + 2);
      if (closeDel !== -1) {
        const delText = input.slice(i + 2, closeDel);
        tokens.push({ type: "del", text: delText });
        i = closeDel + 2;
        continue;
      }
    }

    // 4. Bold / Italic / Bold-Italic (* or _)
    // Check for bold-italic ***text*** or ___text___
    if (input.startsWith("***", i)) {
      const close = input.indexOf("***", i + 3);
      if (close !== -1) {
        tokens.push({ type: "bold_italic", text: input.slice(i + 3, close) });
        i = close + 3;
        continue;
      }
    }
    if (input.startsWith("___", i)) {
      const close = input.indexOf("___", i + 3);
      if (close !== -1) {
        tokens.push({ type: "bold_italic", text: input.slice(i + 3, close) });
        i = close + 3;
        continue;
      }
    }

    // Check for bold **...**
    if (input.startsWith("**", i)) {
      let closeIdx = -1;
      let searchPos = i + 2;
      while (searchPos < len) {
        const nextTwo = input.indexOf("**", searchPos);
        if (nextTwo === -1) break;
        let candidate = nextTwo;
        // Handle bold with adjacent italic, e.g. **Why the header says *"Ran commands 9s"***:
        if (input[nextTwo + 2] === "*" && input[nextTwo + 3] !== "*") {
          const innerBefore = input.slice(i + 2, candidate);
          const starCount = (innerBefore.match(/(?<!\*)\*(?!\*)/g) || []).length;
          if (starCount % 2 === 1) {
            candidate = nextTwo + 1;
          }
        }
        closeIdx = candidate;
        break;
      }

      if (closeIdx !== -1) {
        const boldText = input.slice(i + 2, closeIdx);
        tokens.push({ type: "bold", text: boldText });
        i = closeIdx + 2;
        continue;
      }
    }

    // Check for bold __...__
    if (input.startsWith("__", i)) {
      const closeUnderscore = input.indexOf("__", i + 2);
      if (closeUnderscore !== -1) {
        tokens.push({ type: "bold", text: input.slice(i + 2, closeUnderscore) });
        i = closeUnderscore + 2;
        continue;
      }
    }

    // Check for italic *text* (single *)
    if (input[i] === "*" && input[i + 1] !== "*" && (i === 0 || input[i - 1] !== "*")) {
      const closeStar = input.indexOf("*", i + 1);
      if (
        closeStar !== -1 &&
        input[closeStar + 1] !== "*" &&
        (closeStar === 0 || input[closeStar - 1] !== "*")
      ) {
        tokens.push({ type: "italic", text: input.slice(i + 1, closeStar) });
        i = closeStar + 1;
        continue;
      }
    }

    // Check for italic _text_ (single _)
    if (input[i] === "_" && input[i + 1] !== "_" && (i === 0 || input[i - 1] !== "_")) {
      const closeUnder = input.indexOf("_", i + 1);
      if (
        closeUnder !== -1 &&
        input[closeUnder + 1] !== "_" &&
        (closeUnder === 0 || input[closeUnder - 1] !== "_")
      ) {
        tokens.push({ type: "italic", text: input.slice(i + 1, closeUnder) });
        i = closeUnder + 1;
        continue;
      }
    }

    // 5. Bare URLs: https?://
    if (input.startsWith("http://", i) || input.startsWith("https://", i)) {
      const urlMatch = input.slice(i).match(/^(https?:\/\/[^\s<>"`]+)/);
      if (urlMatch) {
        const rawUrl = urlMatch[1];
        const cleanUrl = rawUrl.replace(/[.,;:!?)\]]+$/, "");
        tokens.push({ type: "url", url: cleanUrl });
        i += cleanUrl.length;
        continue;
      }
    }

    // 6. Plain character accumulation
    const lastTok = tokens[tokens.length - 1];
    if (lastTok && lastTok.type === "text") {
      lastTok.text = (lastTok.text ?? "") + input[i];
    } else {
      tokens.push({ type: "text", text: input[i] });
    }
    i++;
  }

  return tokens;
}

export function renderInlineTokens(text: string, keyPrefix: string): React.ReactNode[] {
  const tokens = tokenizeInline(text);
  const nodes: React.ReactNode[] = [];

  tokens.forEach((t, idx) => {
    const k = `${keyPrefix}-${idx}`;
    if (t.type === "text") {
      nodes.push(t.text ?? "");
    } else if (t.type === "bold") {
      nodes.push(
        <strong key={k} className="md-strong">
          {renderInlineTokens(t.text ?? "", `${k}-b`)}
        </strong>
      );
    } else if (t.type === "italic") {
      nodes.push(
        <em key={k} className="md-em">
          {renderInlineTokens(t.text ?? "", `${k}-i`)}
        </em>
      );
    } else if (t.type === "bold_italic") {
      nodes.push(
        <strong key={k} className="md-strong">
          <em className="md-em">{renderInlineTokens(t.text ?? "", `${k}-bi`)}</em>
        </strong>
      );
    } else if (t.type === "del") {
      nodes.push(
        <del key={k} className="md-del">
          {renderInlineTokens(t.text ?? "", `${k}-d`)}
        </del>
      );
    } else if (t.type === "code") {
      nodes.push(
        <code key={k} className="md-code-inline">
          {renderInlineCodeContent(t.text ?? "")}
        </code>
      );
    } else if (t.type === "link" && t.label && t.url) {
      const url = t.url.trim();
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
            <span>{t.label}</span>
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
            {t.label}
          </button>
        );
      } else {
        nodes.push(
          <code key={k} className="md-code-inline">
            {t.label}
          </code>
        );
      }
    } else if (t.type === "url" && t.url) {
      const url = t.url;
      nodes.push(
        <button
          key={k}
          type="button"
          className="md-ext-link"
          onClick={() => void novaApi.openExternalUrl(url)}
        >
          {url}
        </button>
      );
    }
  });

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

const AGENT_EMBED_SINGLE_RE =
  /^<agent-embed\b[^>]*\bsrc=(?:"([^"]+)"|'([^']+)')[^>]*>(?:\s*<\/agent-embed>)?$/i;

export function isValidLiveEmbedSrc(rawSrc: string): boolean {
  const s = rawSrc.trim();
  if (!s) return false;
  // Reject documentation placeholders like `file:///...` or `file:///<artifact_path>/widget.html`
  if (s.includes("...") || /[<>{}*$]/.test(s)) return false;
  const resolved = normalizeEmbedSrcPath(s).replace(/\\/g, "/");
  if (!/\.(html|htm)$/i.test(resolved)) return false;
  const isAbsOrFileUri =
    s.startsWith("file://") || /^[a-zA-Z]:\//.test(resolved) || resolved.startsWith("/");
  if (!isAbsOrFileUri) return false;
  const fileName = resolved.split("/").pop() || "";
  return fileName.length > 5 && !fileName.startsWith(".");
}

export function extractEmbeddedArtifactPaths(markdown?: string | null): Set<string> {
  const out = new Set<string>();
  if (!markdown) return out;
  const lines = markdown.split("\n");
  let inFence = false;
  for (const rawLine of lines) {
    const t = rawLine.trim();
    if (t.startsWith("```")) {
      inFence = !inFence;
      continue;
    }
    if (inFence || !t) continue;
    const m = t.match(AGENT_EMBED_SINGLE_RE);
    if (!m) continue;
    const raw = (m[1] ?? m[2] ?? "").trim();
    if (!isValidLiveEmbedSrc(raw)) continue;
    const norm = normalizeEmbedSrcPath(raw)
      .replace(/\\/g, "/")
      .replace(/\/+$/, "")
      .toLowerCase();
    if (norm) out.add(norm);
  }
  return out;
}

export interface MarkdownRenderOptions {
  conversationId?: string | null;
  compact?: boolean;
}

export function renderMarkdownBlocks(
  markdown: string,
  options?: MarkdownRenderOptions
): React.ReactNode[] {
  const trimmed = markdown.trim();
  if (!trimmed) return [];

  const lines = trimmed.split("\n");
  const blocks: React.ReactNode[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const t = line.trim();

    if (!t) {
      i++;
      continue;
    }

    // Standalone Generative UI `<agent-embed src="file:///.../widget.html"></agent-embed>`
    // Only triggers on its own non-backticked block line with a real `.html`/`.htm` artifact path.
    const embedMatch = t.match(AGENT_EMBED_SINGLE_RE);
    if (embedMatch) {
      const embedSrc = (embedMatch[1] ?? embedMatch[2] ?? "").trim();
      if (isValidLiveEmbedSrc(embedSrc)) {
        blocks.push(
          <AgentEmbedWidget
            key={`embed-${i}-${embedSrc}`}
            srcPath={embedSrc}
            conversationId={options?.conversationId}
            compact={options?.compact}
            inline
          />
        );
        i++;
        continue;
      }
    }

    // Markdown table (`| col1 | col2 |` + separator `| --- | --- |`)
    if (
      t.startsWith("|") &&
      i + 1 < lines.length &&
      /^\s*\|?[\s:-]+\|[\s|:-]*$/.test(lines[i + 1])
    ) {
      const splitTableCells = (row: string) =>
        row
          .trim()
          .replace(/^\|/, "")
          .replace(/\|$/, "")
          .split("|")
          .map((c) => c.trim());

      const headers = splitTableCells(lines[i]);
      const rows: string[][] = [];
      i += 2; // skip header + separator line
      while (i < lines.length && lines[i].trim().startsWith("|")) {
        rows.push(splitTableCells(lines[i]));
        i++;
      }
      blocks.push(
        <div key={`tbl-${i}`} className="md-table-wrap">
          <table className="md-table">
            <thead>
              <tr>
                {headers.map((h, hIdx) => (
                  <th key={hIdx}>{renderInlineTokens(h, `th-${i}-${hIdx}`)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, rIdx) => (
                <tr key={rIdx}>
                  {headers.map((_h, cIdx) => (
                    <td key={cIdx}>
                      {renderInlineTokens(r[cIdx] ?? "", `td-${i}-${rIdx}-${cIdx}`)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
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

    // Blockquote & GitHub-style Alerts (`> [!NOTE]`, `> [!TIP]`, `> [!IMPORTANT]`, `> [!WARNING]`, `> [!CAUTION]`)
    if (t.startsWith(">")) {
      const bqLines: string[] = [];
      while (i < lines.length) {
        const cur = lines[i].trim();
        if (!cur.startsWith(">")) break;
        bqLines.push(cur.replace(/^>\s?/, ""));
        i++;
      }
      const firstLine = bqLines[0] ?? "";
      const alertMatch = firstLine.match(/^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*(.*)$/i);
      if (alertMatch) {
        const kind = alertMatch[1].toLowerCase();
        const restFirst = alertMatch[2];
        const bodyText = [restFirst, ...bqLines.slice(1)].filter(Boolean).join(" ");
        blocks.push(
          <div key={`alert-${i}`} className={`md-alert md-alert-${kind}`}>
            <span className="md-alert-tag">{alertMatch[1].toUpperCase()}</span>
            <span className="md-alert-body">{renderInlineTokens(bodyText, `al-${i}`)}</span>
          </div>
        );
      } else {
        blocks.push(
          <blockquote key={`bq-${i}`} className="md-blockquote">
            {renderInlineTokens(bqLines.join(" "), `bq-${i}`)}
          </blockquote>
        );
      }
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

  return blocks;
}

interface IdeMarkdownProps {
  markdown: string;
  compact?: boolean;
  lang: Lang;
  conversationId?: string | null;
}

export const IdeMarkdown: React.FC<IdeMarkdownProps> = ({
  markdown,
  compact,
  conversationId,
}) => {
  const trimmed = markdown.trim();
  if (!trimmed) return null;

  const blocks = renderMarkdownBlocks(trimmed, { conversationId, compact });

  return (
    <div className="ide-md-wrap">
      <div className="ide-md-body">{blocks}</div>
    </div>
  );
};
