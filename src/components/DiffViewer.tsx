import React from "react";
import { ExternalLink, FileCode2 } from "lucide-react";
import { FileDiffPreview } from "../types";
import { novaApi } from "../lib/novaClient";

interface DiffViewerProps {
  diff: FileDiffPreview;
  compact?: boolean;
}

export const DiffViewer: React.FC<DiffViewerProps> = ({ diff, compact = false }) => {
  const lines = diff.unifiedDiff.split("\n");
  const visibleLines = compact ? lines.slice(0, 28) : lines;

  const shortName = diff.filePath.split(/[/\\]/).pop() || diff.filePath;

  return (
    <div className="nova-diff-box">
      <div className="nova-diff-header">
        <div className="nova-diff-title" title={diff.filePath}>
          <FileCode2 size={14} />
          <span>{shortName}</span>
          <span className="diff-stat-add">+{diff.addedLines}</span>
          <span className="diff-stat-del">-{diff.removedLines}</span>
        </div>
        <button
          className="nova-btn-ghost nova-btn-xs"
          onClick={() => novaApi.openInEditor(diff.filePath, undefined, "antigravity")}
          title="Open in Antigravity / VS Code"
        >
          <ExternalLink size={12} />
          <span>Open</span>
        </button>
      </div>
      <pre className="nova-diff-pre">
        {visibleLines.map((line, i) => {
          let cls = "diff-line";
          if (line.startsWith("+") && !line.startsWith("+++")) cls += " diff-add";
          else if (line.startsWith("-") && !line.startsWith("---")) cls += " diff-del";
          else if (line.startsWith("@@")) cls += " diff-hunk";
          return (
            <div key={i} className={cls}>
              {line || " "}
            </div>
          );
        })}
      </pre>
    </div>
  );
};
