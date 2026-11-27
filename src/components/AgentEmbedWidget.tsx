import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { ExternalLink, Loader2, Maximize2, Minimize2, RotateCw } from "lucide-react";
import { getApiBase, novaApi } from "../lib/novaClient";

export function normalizeEmbedSrcPath(rawSrc: string): string {
  const trimmed = rawSrc.trim();
  if (!trimmed) return "";
  if (trimmed.startsWith("file://")) {
    try {
      const withoutScheme = trimmed.replace(/^file:\/\/\/?/, "");
      const [rawPath] = withoutScheme.split(/[?#]/);
      const decoded = decodeURIComponent(rawPath);
      return /^[a-zA-Z]:/.test(decoded) ? decoded : `/${decoded}`;
    } catch {
      return trimmed.replace(/^file:\/\/\/?/, "");
    }
  }
  return trimmed;
}

export interface AgentEmbedWidgetProps {
  srcPath: string;
  conversationId?: string | null;
  compact?: boolean;
  inline?: boolean;
  title?: string;
}

export const AgentEmbedWidget: React.FC<AgentEmbedWidgetProps> = ({
  srcPath,
  conversationId,
  compact = false,
  inline = true,
  title,
}) => {
  const reactId = useId();
  const embedId = useMemo(
    () => `nova-emb-${reactId.replace(/[^a-zA-Z0-9_-]/g, "")}`,
    [reactId]
  );
  const resolvedPath = useMemo(() => normalizeEmbedSrcPath(srcPath), [srcPath]);
  const fileLabel = useMemo(
    () => title || resolvedPath.split(/[/\\]/).pop() || "widget.html",
    [title, resolvedPath]
  );

  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const [renderPath, setRenderPath] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [frameReady, setFrameReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [contentHeight, setContentHeight] = useState<number>(inline ? 180 : 320);
  const [expanded, setExpanded] = useState(false);
  const [reloadSeq, setReloadSeq] = useState(0);

  const defaultMaxHeight = compact ? 400 : inline ? 460 : 560;
  const maxViewportHeight = expanded ? 800 : defaultMaxHeight;
  const clampedHeight = Math.max(42, Math.min(contentHeight, maxViewportHeight));
  const canExpand = contentHeight > defaultMaxHeight + 12;

  const fetchTicket = useCallback(async () => {
    if (!resolvedPath) {
      setError("Empty embed artifact path");
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await novaApi.createEmbedTicket({
        filePath: resolvedPath,
        conversationId,
        embedId,
        inline,
      });
      if (res.ok && res.renderPath) {
        setRenderPath(res.renderPath);
      } else {
        setError(res.error || "Unable to load interactive HTML widget");
        setLoading(false);
      }
    } catch (err) {
      setError(String(err));
      setLoading(false);
    }
  }, [resolvedPath, conversationId, embedId, inline]);

  useEffect(() => {
    setFrameReady(false);
    void fetchTicket();
  }, [fetchTicket]);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (!iframeRef.current || event.source !== iframeRef.current.contentWindow) {
        return;
      }
      const data = event.data as
        | { type?: string; embedId?: string; height?: unknown }
        | undefined;
      if (
        !data ||
        data.type !== "nova-agent-embed-resize" ||
        data.embedId !== embedId ||
        typeof data.height !== "number" ||
        !Number.isFinite(data.height)
      ) {
        return;
      }
      const next = Math.max(36, Math.ceil(data.height));
      setContentHeight(next);
      setFrameReady(true);
      setLoading(false);
    };

    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [embedId]);

  const handleReload = () => {
    setFrameReady(false);
    setReloadSeq((s) => s + 1);
    void fetchTicket();
  };

  if (error) {
    return null;
  }

  const fullFrameUrl = renderPath
    ? `${getApiBase()}${renderPath}&rev=${reloadSeq}`
    : null;

  return (
    <div
      className={`nova-agent-embed ${inline ? "is-inline" : "is-standalone"} ${
        frameReady ? "is-ready" : "is-loading"
      }`}
    >
      <div className="nova-agent-embed-toolbar">
        {canExpand && (
          <button
            type="button"
            className="nova-agent-embed-btn"
            onClick={() => setExpanded((v) => !v)}
            title={expanded ? "Collapse height" : "Expand full height (up to 800px)"}
          >
            {expanded ? <Minimize2 size={10.5} /> : <Maximize2 size={10.5} />}
          </button>
        )}
        <button
          type="button"
          className="nova-agent-embed-btn"
          onClick={handleReload}
          title="Reload interactive widget"
        >
          <RotateCw size={10.5} />
        </button>
        <button
          type="button"
          className="nova-agent-embed-btn"
          onClick={() => void novaApi.openInEditor(resolvedPath, undefined, "antigravity")}
          title={`Open ${fileLabel} in Antigravity IDE`}
        >
          <ExternalLink size={10.5} />
        </button>
      </div>

      {(loading || !frameReady) && (
        <div className="nova-agent-embed-skeleton">
          <Loader2 size={12} className="spin-icon" />
          <span>Loading {fileLabel}…</span>
        </div>
      )}

      {fullFrameUrl && (
        <iframe
          ref={iframeRef}
          src={fullFrameUrl}
          title={fileLabel}
          sandbox="allow-scripts"
          className="nova-agent-embed-frame"
          style={{
            height: `${clampedHeight}px`,
            overflowY: contentHeight > maxViewportHeight ? "auto" : "hidden",
          }}
          onLoad={() => {
            setFrameReady(true);
            setLoading(false);
          }}
        />
      )}
    </div>
  );
};
