import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  Camera,
  ChevronDown,
  CheckSquare,
  Clipboard,
  Cpu,
  ExternalLink,
  FolderGit2,
  Gauge,
  GitBranch,
  Github,
  Globe,
  ImagePlus,
  Layers,
  MessageSquare,
  Mic,
  Music,
  Pause,
  Play,
  Plus,
  RotateCcw,
  Send,
  Settings,
  SkipForward,
  Trash2,
  User,
  X,
  Zap,
} from "lucide-react";
import {
  AgentSession,
  AVAILABLE_MODELS,
  GitHubOverview,
  HardwareTelemetry,
  MediaStatus,
  NovaSnapshot,
  PortProcessInfo,
} from "../types";
import { Lang, t } from "../i18n";
import { isTauriRuntime, novaApi } from "../lib/novaClient";
import { getRecentProjectPaths, rememberRecentProjectPath } from "../lib/projectHistory";
import { listenForNativeDialogState, withNativeDialog } from "../lib/nativeDialog";
import {
  buildPopoverExtraRects,
  computePopoverPlacement,
  hitTestIslandRegions,
  HoverRect,
  ISLAND_HOVER_REGION_EVENT,
  ISLAND_POPOVER_SELECT_EVENT,
  IslandPopoverSelectDetail,
  notifyIslandPopoverSelect,
  resolvePopoverSelectCollapseLock,
  stepIslandPointerHoverState,
} from "../lib/islandHover";
import { playNovaCue, warmNovaAudio } from "../lib/soundEngine";
import {
  clamp,
  ISLAND_CLOSE_DAMPING,
  ISLAND_CLOSE_RESPONSE,
  ISLAND_OPEN_DAMPING,
  ISLAND_OPEN_RESPONSE,
  prefersReducedMotion,
  revealCurve,
  TrackedValue,
} from "../lib/islandSpring";
import { NovaOrb, NovaOrbIntroPose, OrbState } from "../components/NovaOrb";
import { SupernovaIntroOverlay } from "../components/SupernovaIntroOverlay";
import { ApprovalCard } from "../components/ApprovalCard";
import { QuestionCard } from "../components/QuestionCard";
import { DiffViewer } from "../components/DiffViewer";
import { renderMarkdownBlocks } from "../components/IdeMarkdown";
import { SessionTelemetryView } from "../components/SessionTelemetryView";
import {
  fileToDataUrl,
  isSupportedImageFile,
  NewRunBar,
  SessionCockpit,
} from "../components/SessionCockpit";
import { VoiceRecorderPanel } from "../components/VoiceRecorderPanel";
import { ProjectSelectHero } from "../components/ProjectSelectHero";

interface IslandSurfaceProps {
  snapshot: NovaSnapshot;
  telemetry: HardwareTelemetry | null;
  ports: PortProcessInfo[];
  media: MediaStatus | null;
  github: GitHubOverview | null;
  onRefreshSystem: () => void;
  embeddedPreview?: boolean;
}

const PILL_HEIGHT = 38;
const PILL_RADIUS = 19;
const EXPANDED_WIDTH = 840;
const EXPANDED_RADIUS = 26;
const MIN_PILL_WIDTH = 176;
const PILL_BREATHING_EXTRA_PX = 22;
const MAX_PILL_WIDTH = 380;
const MAX_EXPANDED_HEIGHT = 626;
const SHADOW_BASE_W = 880;
const SHADOW_BASE_H = 520;
const STARTUP_DROP_MS = 160;
const STARTUP_UNFURL_DELAY_MS = 100;

const isNovaCliSession = (session: AgentSession) => {
  const transcriptPath = session.transcriptPath?.replace(/\\/g, "/").toLowerCase() ?? "";
  const isAppTranscript = transcriptPath.includes("/.gemini/antigravity/") &&
    !transcriptPath.includes("/.gemini/antigravity-cli/");
  if (isAppTranscript) return false;
  return transcriptPath.includes("/.gemini/antigravity-cli/") ||
    Boolean(session.cliConversationId) ||
    session.conversationId.startsWith("pending-");
};

export const IslandSurface: React.FC<IslandSurfaceProps> = ({
  snapshot,
  telemetry,
  ports,
  media,
  github,
  onRefreshSystem,
  embeddedPreview = false,
}) => {
  const { settings, sessions, pendingApprovals, focus } = snapshot;
  const pendingQuestions = snapshot.pendingQuestions ?? [];
  const totalUrgentCount = pendingApprovals.length + pendingQuestions.length;
  const hasCloudSttKey = Boolean(
    (settings.sttProvider === "groq" && snapshot.secrets.groq) ||
      (settings.sttProvider === "gemini" && snapshot.secrets.gemini) ||
      (settings.sttProvider === "openai" && snapshot.secrets.openai)
  );
  const lang: Lang = settings.language;

  const [activeTab, setActiveTabState] = useState<"mission" | "chat" | "voice" | "devtools">("mission");
  const [tabAnimated, setTabAnimated] = useState(false);
  const setActiveTab = useCallback((next: "mission" | "chat" | "voice" | "devtools") => {
    setTabAnimated(expandedRef.current);
    setActiveTabState(next);
  }, []);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [isNewChatDraft, setIsNewChatDraft] = useState(true);

  // Chat state
  const [chatInput, setChatInput] = useState("");
  const [chatSending, setChatSending] = useState(false);
  const [selectedWorkspacePath, setSelectedWorkspacePath] = useState("");
  const [addedWorkspacePaths, setAddedWorkspacePaths] = useState<string[]>([]);
  const [projectMenuOpen, setProjectMenuOpen] = useState(false);
  const [projectMenuPosition, setProjectMenuPosition] = useState<{
    top: number;
    left: number;
    maxHeight: number;
  } | null>(null);
  const projectSwitcherRef = useRef<HTMLDivElement | null>(null);
  const projectMenuRef = useRef<HTMLDivElement | null>(null);
  const [recentProjectPaths, setRecentProjectPaths] = useState<string[]>(getRecentProjectPaths);
  const [hiddenProjectPaths, setHiddenProjectPaths] = useState<string[]>(() => {
    try { return JSON.parse(localStorage.getItem("nova_hidden_project_tabs") || "[]"); } catch { return []; }
  });
  const [hiddenChatIds, setHiddenChatIds] = useState<string[]>(() => {
    try { return JSON.parse(localStorage.getItem("nova_hidden_chat_tabs") || "[]"); } catch { return []; }
  });
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const [snipPreview, setSnipPreview] = useState<string | null>(null);
  const [droppedFilePath, setDroppedFilePath] = useState<string | null>(null);
  const [showClipboardDrawer, setShowClipboardDrawer] = useState(false);

  // Dev utilities sub-tab state
  const [devSubTab, setDevSubTab] = useState<"ports" | "hardware" | "focus" | "media" | "github">(
    "ports"
  );
  const [newTodoText, setNewTodoText] = useState("");
  const [supernovaIntro, setSupernovaIntro] = useState<{ active: boolean; key: number }>({
    active: false,
    key: 0,
  });
  const supernovaActiveRef = useRef<boolean>(false);
  const supernovaRevealAlphaRef = useRef<number>(1);
  const introOrbPoseRef = useRef<NovaOrbIntroPose | null>(null);

  // DOM measurement & animation refs (zero React re-renders and zero DOM layout reads during expand/collapse)
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const shadowRef = useRef<HTMLDivElement | null>(null);
  const shellRef = useRef<HTMLDivElement | null>(null);
  const topbarRef = useRef<HTMLDivElement | null>(null);
  const islandBodyRef = useRef<HTMLDivElement | null>(null);
  const pillLayerRef = useRef<HTMLDivElement | null>(null);
  const pillMeasureRef = useRef<HTMLDivElement | null>(null);
  const pillSizerRef = useRef<HTMLDivElement | null>(null);
  const closedStatusRef = useRef<HTMLDivElement | null>(null);
  const expandedLayerRef = useRef<HTMLDivElement | null>(null);
  const expandedMeasureRef = useRef<HTMLDivElement | null>(null);
  const chatFileInputRef = useRef<HTMLInputElement | null>(null);

  const pillOrbActiveRef = useRef<boolean>(!embeddedPreview);
  const pillOrbWakeRef = useRef<(() => void) | null>(null);
  const expOrbActiveRef = useRef<boolean>(embeddedPreview);
  const expOrbWakeRef = useRef<(() => void) | null>(null);
  const isMorphingRef = useRef<boolean>(false);

  const vpSizeRef = useRef<{ w: number; h: number }>({
    w: typeof window !== "undefined" ? window.innerWidth || 900 : 900,
    h: typeof window !== "undefined" ? window.innerHeight || 690 : 690,
  });
  const lastAppliedExpWRef = useRef<number>(0);
  const lastRectPushMsRef = useRef<number>(0);

  const foldTimerRef = useRef<number | null>(null);
  const refreshTimerRef = useRef<number | null>(null);

  const pillWidthRef = useRef<number>(176);
  const expandedHeightRef = useRef<number>(280);
  const expandedRef = useRef<boolean>(embeddedPreview);
  const startupIntroPlayedRef = useRef(false);
  const startupIntroActiveRef = useRef(false);
  const startupIntroStartedAtRef = useRef(0);
  const startupUnfurlStartedRef = useRef(false);
  const pillHoveredRef = useRef<boolean>(false);
  const proximityRef = useRef<number>(0);
  const pointerInsideRef = useRef<boolean>(false);
  const suppressCollapseUntilMainReturnRef = useRef<boolean>(false);
  const lastPointerPosRef = useRef<{ x: number; y: number } | null>(null);
  const pushedExtraKeyRef = useRef<string>("");
  const keepOpenAfterSendUntilRef = useRef<number>(0);
  const nativeDialogOpenRef = useRef<boolean>(false);
  const soundEnabledRef = useRef<boolean>(settings.soundEnabled);
  const snapZoneRef = useRef<string>(settings.snapZone);
  const monitorIndexRef = useRef<number>(settings.monitorIndex);
  const pendingCountRef = useRef<number>(totalUrgentCount);
  const collapseDelayMsRef = useRef<number>(settings.islandCollapseDelayMs ?? 0);
  const suppressFullscreenSettingRef = useRef<boolean>(Boolean(settings.suppressFullscreen));
  const liveFullscreenRef = useRef<boolean | null>(null);
  const suppressFullscreenRef = useRef<boolean>(
    Boolean(settings.suppressFullscreen && telemetry?.fullscreenActive)
  );

  soundEnabledRef.current = settings.soundEnabled;
  snapZoneRef.current = settings.snapZone;
  monitorIndexRef.current = settings.monitorIndex;
  pendingCountRef.current = totalUrgentCount;
  collapseDelayMsRef.current = Math.max(0, Math.min(60_000, settings.islandCollapseDelayMs ?? 0));
  suppressFullscreenSettingRef.current = Boolean(settings.suppressFullscreen);
  suppressFullscreenRef.current = Boolean(
    settings.suppressFullscreen && (liveFullscreenRef.current ?? telemetry?.fullscreenActive)
  );

  // Physics tracks initialized to starting state
  const widthTrackRef = useRef<TrackedValue>(
    new TrackedValue(embeddedPreview ? EXPANDED_WIDTH : 176)
  );
  const heightTrackRef = useRef<TrackedValue>(
    new TrackedValue(embeddedPreview ? 280 : PILL_HEIGHT)
  );
  const radiusTrackRef = useRef<TrackedValue>(
    new TrackedValue(embeddedPreview ? EXPANDED_RADIUS : PILL_RADIUS)
  );
  const rafIdRef = useRef<number>(0);
  const lastFrameMsRef = useRef<number>(0);
  const pushedRectRef = useRef<{ x: number; y: number; w: number; h: number }>({
    x: -1,
    y: -1,
    w: -1,
    h: -1,
  });

  const cliSessions = useMemo(() => sessions.filter(isNovaCliSession), [sessions]);
  const activeAgentCount = useMemo(
    () => cliSessions.filter((s) => s.status === "active" || s.status === "waiting_approval").length,
    [cliSessions]
  );

  const orbState: OrbState =
    totalUrgentCount > 0
      ? "alert"
      : activeAgentCount > 0
      ? "active"
      : "idle";

  const liveClosedStatus = useMemo(() => {
    if (pendingQuestions.length > 0) {
      return {
        cls: "closed-alert-text",
        text: `${pendingQuestions.length} ${t(lang, "waitingQuestion")}`,
      };
    }
    if (pendingApprovals.length > 0) {
      return {
        cls: "closed-alert-text",
        text: `${pendingApprovals.length} ${t(lang, "waitingApproval")}`,
      };
    }
    if (activeAgentCount > 0) {
      const live = cliSessions.find(
        (s) => s.status === "active" || s.status === "waiting_approval"
      );
      let label = `${activeAgentCount} ${t(lang, "activeAgents")}`;
      if (live?.phase === "thinking") {
        label = lang === "th" ? "กำลังคิด…" : "Thinking…";
      } else if (live?.activeTool) {
        label =
          live.activeTool.length > 30
            ? `${live.activeTool.slice(0, 30)}…`
            : live.activeTool;
      }
      return { cls: "closed-active-text", text: label };
    }
    return { cls: "closed-idle-text", text: t(lang, "idleReady") };
  }, [activeAgentCount, cliSessions, lang, pendingApprovals.length, pendingQuestions.length]);

  const [displayedClosedStatus, setDisplayedClosedStatus] = useState(liveClosedStatus);
  const [pillAwaitingExpand, setPillAwaitingExpand] = useState(false);
  const [pillTextAnimSeq, setPillTextAnimSeq] = useState(0);
  const pendingClosedStatusRef = useRef(liveClosedStatus);
  const isExpandingPillContentRef = useRef(false);
  const pillExpandStartWRef = useRef(MIN_PILL_WIDTH);
  const commitPendingPillContentRef = useRef<(() => void) | null>(null);

  commitPendingPillContentRef.current = () => {
    isExpandingPillContentRef.current = false;
    setDisplayedClosedStatus(pendingClosedStatusRef.current);
    setPillAwaitingExpand(false);
    setPillTextAnimSeq((seq) => seq + 1);
  };

  const syncDomShellFlags = useCallback(() => {
    const shell = shellRef.current;
    if (shell) {
      shell.classList.toggle("is-expanded", expandedRef.current);
      shell.classList.toggle("is-folded", !expandedRef.current);
      shell.classList.toggle("is-prewake", !expandedRef.current && pillHoveredRef.current);
    }
    pillLayerRef.current?.setAttribute("aria-hidden", String(expandedRef.current));
    expandedLayerRef.current?.setAttribute("aria-hidden", String(!expandedRef.current));
  }, []);

  const getMaxExpandedWidth = useCallback(() => {
    const vw = vpSizeRef.current.w;
    if (embeddedPreview) {
      return Math.min(EXPANDED_WIDTH, Math.max(320, vw - 32));
    }
    return vw > 420 ? Math.min(EXPANDED_WIDTH, vw - 24) : EXPANDED_WIDTH;
  }, [embeddedPreview]);

  const computeZoneRect = useCallback(
    (boxW: number, boxH: number) => {
      const zone = embeddedPreview ? "top-center" : snapZoneRef.current;
      const vpW = vpSizeRef.current.w || 900;
      const vpH = vpSizeRef.current.h || 690;
      let rx = (vpW - boxW) * 0.5;
      let ry = 8;
      if (zone === "top-left") rx = 16;
      else if (zone === "top-right") rx = vpW - boxW - 16;
      if (zone === "bottom-dock") ry = vpH - boxH - 14;
      return { rx, ry, zone };
    },
    [embeddedPreview]
  );

  const getSettledMainIslandRect = useCallback((): HoverRect => {
    const isExp = expandedRef.current;
    const w = isExp ? getMaxExpandedWidth() : pillWidthRef.current;
    const h = isExp ? expandedHeightRef.current : PILL_HEIGHT;
    const { rx, ry } = computeZoneRect(w, h);
    return { x: rx, y: ry, w, h };
  }, [computeZoneRect, getMaxExpandedWidth]);

  const collectPopoverExtraRects = useCallback((mainRect: HoverRect): HoverRect[] => {
    if (!expandedRef.current) return [];
    const rawRects: HoverRect[] = [];
    document
      .querySelectorAll<HTMLElement>("[data-nova-island-hover-region='true']")
      .forEach((region) => {
        const rect = region.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          rawRects.push({ x: rect.left, y: rect.top, w: rect.width, h: rect.height });
        }
      });
    return buildPopoverExtraRects(mainRect, rawRects);
  }, []);

  const pushHitRectIfNeeded = useCallback(
    (rx: number, ry: number, hitW: number, hitH: number, force = false) => {
      if (embeddedPreview) return;
      const now = performance.now();
      if (!force && now - lastRectPushMsRef.current < 48) return;
      const mainRect: HoverRect = { x: rx, y: ry, w: hitW, h: hitH };
      const extraRects = collectPopoverExtraRects(mainRect);
      const extraKey = extraRects
        .map((r) => `${Math.round(r.x)},${Math.round(r.y)},${Math.round(r.w)},${Math.round(r.h)}`)
        .join("|");
      const prev = pushedRectRef.current;
      const isExpNow = expandedRef.current;
      if (
        force ||
        extraKey !== pushedExtraKeyRef.current ||
        Math.abs(prev.x - mainRect.x) > 0.5 ||
        Math.abs(prev.y - mainRect.y) > 0.5 ||
        Math.abs(prev.w - mainRect.w) > 0.5 ||
        Math.abs(prev.h - mainRect.h) > 0.5
      ) {
        pushedRectRef.current = mainRect;
        pushedExtraKeyRef.current = extraKey;
        lastRectPushMsRef.current = now;
        novaApi.setIslandRect(mainRect.x, mainRect.y, mainRect.w, mainRect.h, extraRects, isExpNow);
      }
    },
    [collectPopoverExtraRects, embeddedPreview]
  );

  // Portaled menus sit outside the shell, so sync their exact bounds as separate hover regions.
  useEffect(() => {
    const syncPopoverHitRegion = () => {
      const main = getSettledMainIslandRect();
      pushHitRectIfNeeded(main.x, main.y, main.w, main.h, true);
    };
    window.addEventListener(ISLAND_HOVER_REGION_EVENT, syncPopoverHitRegion);
    return () => window.removeEventListener(ISLAND_HOVER_REGION_EVENT, syncPopoverHitRegion);
  }, [getSettledMainIslandRect, pushHitRectIfNeeded]);

  const applyFrameStyles = useCallback(
    (stillMoving = false) => {
      const shell = shellRef.current;
      const pillLayer = pillLayerRef.current;
      const expandedLayer = expandedLayerRef.current;
      if (!shell || !pillLayer || !expandedLayer) return;

      const targetExpW = getMaxExpandedWidth();
      if (lastAppliedExpWRef.current !== targetExpW) {
        lastAppliedExpWRef.current = targetExpW;
        expandedLayer.style.width = `${targetExpW}px`;
      }

      // Never allow background effects, pointer proximity, or resize listeners to overwrite
      // shell/pill transforms while SupernovaIntroOverlay is actively driving the intro!
      if (supernovaActiveRef.current) return;

      const w = widthTrackRef.current.value;
      const h = heightTrackRef.current.value;
      const r = radiusTrackRef.current.value;

      const basePillW = pillWidthRef.current;
      const targetExpH = expandedHeightRef.current;
      const spanW = Math.max(1, targetExpW - basePillW);
      const spanH = Math.max(1, targetExpH - PILL_HEIGHT);
      const pw = clamp((w - basePillW) / spanW, 0, 1);
      const ph = clamp((h - PILL_HEIGHT) / spanH, 0, 1);
      const isOpening = expandedRef.current;
      const p = isOpening ? pw : Math.min(pw, ph);
      const isBottom = snapZoneRef.current === "bottom-dock" && !embeddedPreview;
      const { rx: shellX, ry: shellY, zone } = computeZoneRect(w, h);
      const startupElapsed = startupIntroActiveRef.current
        ? performance.now() - startupIntroStartedAtRef.current
        : 0;
      const startupDropProgress = clamp(startupElapsed / STARTUP_DROP_MS, 0, 1);
      const startupDropOffset = startupIntroActiveRef.current
        ? -12 * (1 - revealCurve(startupDropProgress))
        : 0;
      const frameShellY = shellY + startupDropOffset;
      // Zero-scale pre-wake (`wakeScale = 1`): never scale the folded shell beyond its exact
      // CSS hit-rect so visual pixels and hover hit-detection match 1:1 with zero phantom gap!
      const wakeScale = 1;

      shell.style.width = `${w.toFixed(2)}px`;
      shell.style.height = `${h.toFixed(2)}px`;
      shell.style.borderRadius = `${r.toFixed(2)}px`;
      if (startupIntroActiveRef.current) {
        shell.style.opacity = clamp(startupElapsed / 95, 0, 1).toFixed(3);
        shell.style.pointerEvents = "";
      } else {
        if (shell.style.opacity) shell.style.opacity = "";
        if (shell.style.pointerEvents) shell.style.pointerEvents = "";
      }
      if (!embeddedPreview) {
        shell.style.transform =
          wakeScale > 1.0005
            ? `translate3d(${shellX.toFixed(2)}px, ${frameShellY.toFixed(2)}px, 0) scale3d(${wakeScale.toFixed(4)}, ${wakeScale.toFixed(4)}, 1)`
            : `translate3d(${shellX.toFixed(2)}px, ${frameShellY.toFixed(2)}px, 0)`;
      }

      if (closedStatusRef.current) {
        if (startupIntroActiveRef.current) {
          const unfurlSpan = Math.max(24, basePillW - PILL_HEIGHT);
          const statusProg = revealCurve(
            clamp(((w - PILL_HEIGHT) / unfurlSpan - 0.32) / 0.68, 0, 1)
          );
          closedStatusRef.current.style.opacity = statusProg.toFixed(4);
          closedStatusRef.current.style.transform = `translate3d(${((1 - statusProg) * -6).toFixed(2)}px, 0, 0)`;
        } else if (closedStatusRef.current.style.opacity || closedStatusRef.current.style.transform) {
          closedStatusRef.current.style.opacity = "";
          closedStatusRef.current.style.transform = "";
        }
      }

      // GPU-scaled ambient shadow quad (never crosses Blink 2x raster boundary, 0ms paint cost)
      if (!embeddedPreview && shadowRef.current) {
        const sx = (w + 36) / SHADOW_BASE_W;
        const sy = (h + 36) / SHADOW_BASE_H;
        const shX = shellX - 18;
        const shY = frameShellY - 8;
        const shAlpha = 0.56 + 0.44 * p;
        shadowRef.current.style.opacity = shAlpha.toFixed(3);
        shadowRef.current.style.transform = `translate3d(${shX.toFixed(2)}px, ${shY.toFixed(
          2
        )}px, 0) scale3d(${sx.toFixed(4)}, ${sy.toFixed(4)}, 1)`;
      }

      // Layer A: Constant-box Compact Pill (keep visibility:visible so GPU tile stays warm in VRAM!)
      const pillFadeWindow = isOpening ? 0.24 : 0.38;
      const rawPillAlpha = clamp(1 - p / pillFadeWindow, 0, 1);
      const pillAlpha = rawPillAlpha * rawPillAlpha * (3 - 2 * rawPillAlpha);
      if (pillAlpha <= 0.002) {
        if (isOpening) pillOrbActiveRef.current = false;
        pillLayer.style.opacity = "0";
        pillLayer.style.visibility = "visible";
        pillLayer.style.pointerEvents = "none";
      } else {
        const isFoldedWidthMorph =
          !isOpening && h <= PILL_HEIGHT + 0.5 && !startupIntroActiveRef.current;
        const activePillBoxW = isFoldedWidthMorph ? w : basePillW;
        const pillScale = isOpening ? 1 + (1 - pillAlpha) * 0.025 : 0.97 + pillAlpha * 0.03;
        const pillX =
          startupIntroActiveRef.current || isFoldedWidthMorph
            ? 0
            : zone === "top-left"
              ? 0
              : zone === "top-right"
                ? w - activePillBoxW
                : (w - activePillBoxW) * 0.5;
        const pillSlideY = (1 - pillAlpha) * (isBottom ? -2.5 : 2.5);
        const pillY = (isBottom ? h - PILL_HEIGHT : 0) + pillSlideY;
        pillLayer.style.width = startupIntroActiveRef.current
          ? ""
          : `${activePillBoxW.toFixed(2)}px`;
        pillLayer.style.visibility = "visible";
        pillLayer.style.opacity = pillAlpha.toFixed(4);
        pillLayer.style.pointerEvents = !isOpening && p < 0.22 ? "auto" : "none";
        pillLayer.style.transform = `translate3d(${pillX.toFixed(2)}px, ${pillY.toFixed(
          2
        )}px, 0) scale3d(${pillScale.toFixed(4)}, ${pillScale.toFixed(4)}, 1)`;
      }

      // Layer B: Unified GPU-cached Expanded Surface (keep visibility:visible + permanent composited layers
      // so neither first expand nor first collapse ever stalls to rasterize or de-promote GPU tiles!)
      const rawExpAlpha = isOpening
        ? clamp((p - 0.14) / 0.78, 0, 1)
        : clamp((p - 0.48) / 0.52, 0, 1);
      const expAlpha = isOpening
        ? revealCurve(rawExpAlpha)
        : rawExpAlpha * rawExpAlpha * (3 - 2 * rawExpAlpha);

      if (isOpening) {
        const headerProgress = revealCurve(clamp((p - 0.04) / 0.42, 0, 1));
        const contentProgress = revealCurve(clamp((p - 0.24) / 0.62, 0, 1));
        if (topbarRef.current) {
          topbarRef.current.style.opacity = headerProgress.toFixed(4);
          topbarRef.current.style.transform = `translate3d(0, ${((1 - headerProgress) * -4).toFixed(2)}px, 0)`;
        }
        if (islandBodyRef.current) {
          islandBodyRef.current.style.opacity = contentProgress.toFixed(4);
          islandBodyRef.current.style.transform = `translate3d(0, ${((1 - contentProgress) * 5).toFixed(2)}px, 0)`;
        }
      } else {
        if (topbarRef.current && topbarRef.current.style.opacity !== "1") {
          topbarRef.current.style.opacity = "1";
          topbarRef.current.style.transform = "translate3d(0, 0, 0)";
        }
        if (islandBodyRef.current && islandBodyRef.current.style.opacity !== "1") {
          islandBodyRef.current.style.opacity = "1";
          islandBodyRef.current.style.transform = "translate3d(0, 0, 0)";
        }
      }

      if (expAlpha <= 0.002) {
        expandedLayer.style.visibility = "visible";
        expandedLayer.style.opacity = "0";
        expandedLayer.style.pointerEvents = "none";
      } else {
        const expScale = isOpening ? 0.968 + 0.032 * expAlpha : 0.945 + 0.055 * expAlpha;
        const expShiftY = (1 - expAlpha) * (isBottom ? 6 : -6);
        const expX =
          zone === "top-left" ? 0 : zone === "top-right" ? w - targetExpW : (w - targetExpW) * 0.5;
        const expY = (isBottom ? h - targetExpH : 0) + expShiftY;

        expandedLayer.style.visibility = "visible";
        expandedLayer.style.opacity = expAlpha.toFixed(4);
        expandedLayer.style.pointerEvents = isOpening && p > 0.52 ? "auto" : "none";
        expandedLayer.style.transform = `translate3d(${expX.toFixed(2)}px, ${expY.toFixed(
          2
        )}px, 0) scale3d(${expScale.toFixed(4)}, ${expScale.toFixed(4)}, 1)`;
      }

      // Sync Tauri hit-rect ONLY at transition boundaries (zero mid-animation WebView2 COM IPC stalls)
      if (!embeddedPreview && !stillMoving) {
        const settleW = isOpening ? targetExpW : basePillW;
        const settleH = isOpening ? targetExpH : PILL_HEIGHT;
        const { rx: sRx, ry: sRy } = computeZoneRect(settleW, settleH);
        pushHitRectIfNeeded(sRx, sRy, settleW, settleH, true);
      }
    },
    [computeZoneRect, embeddedPreview, getMaxExpandedWidth, pushHitRectIfNeeded]
  );

  const ensurePhysicsLoop = useCallback(() => {
    if (rafIdRef.current) return;
    lastFrameMsRef.current = performance.now();
    isMorphingRef.current = true;
    shellRef.current?.classList.add("is-morphing");

    const stepFrame = (now: number) => {
      const dt = Math.min(0.05, Math.max(0.001, (now - lastFrameMsRef.current) / 1000));
      lastFrameMsRef.current = now;

      if (
        startupIntroActiveRef.current &&
        !startupUnfurlStartedRef.current &&
        now - startupIntroStartedAtRef.current >= STARTUP_DROP_MS + STARTUP_UNFURL_DELAY_MS
      ) {
        startupUnfurlStartedRef.current = true;
        widthTrackRef.current.springTo(pillWidthRef.current, ISLAND_OPEN_RESPONSE, ISLAND_OPEN_DAMPING);
      }

      widthTrackRef.current.step(dt, now);
      heightTrackRef.current.step(dt, now);
      radiusTrackRef.current.step(dt, now);

      if (isExpandingPillContentRef.current) {
        const targetW = pillWidthRef.current;
        const span = Math.max(1, targetW - pillExpandStartWRef.current);
        const threshold = targetW - Math.max(3, span * 0.12);
        if (
          expandedRef.current ||
          !widthTrackRef.current.animating ||
          widthTrackRef.current.value >= threshold
        ) {
          commitPendingPillContentRef.current?.();
        }
      }

      const startupStillMoving =
        startupIntroActiveRef.current &&
        (!startupUnfurlStartedRef.current || now - startupIntroStartedAtRef.current < STARTUP_DROP_MS);
      const stillMoving =
        widthTrackRef.current.animating ||
        heightTrackRef.current.animating ||
        radiusTrackRef.current.animating ||
        startupStillMoving;

      applyFrameStyles(stillMoving);

      if (stillMoving) {
        rafIdRef.current = window.requestAnimationFrame(stepFrame);
      } else {
        rafIdRef.current = 0;
        isMorphingRef.current = false;
        startupIntroActiveRef.current = false;
        shellRef.current?.classList.remove("is-morphing", "is-launching");
        // Pause the hidden NovaOrb canvas once morph settles so only 1 orb renders at rest
        pillOrbActiveRef.current = !expandedRef.current;
        expOrbActiveRef.current = expandedRef.current;
      }
    };

    rafIdRef.current = window.requestAnimationFrame(stepFrame);
  }, [applyFrameStyles]);

  const retargetGeometry = useCallback(
    (opts?: { immediate?: boolean }) => {
      const reduced = opts?.immediate || prefersReducedMotion();
      const isExp = expandedRef.current;

      // Keep resting capsule rock-steady (zero pre-hover edge bounce) and morph all 3 axes
      // with coupled critically damped springs (ζ = 1.0) so neither expand nor collapse bounces.
      const targetW = isExp ? getMaxExpandedWidth() : pillWidthRef.current;
      const targetH = isExp ? expandedHeightRef.current : PILL_HEIGHT;
      const targetR = isExp ? EXPANDED_RADIUS : PILL_RADIUS;

      if (reduced) {
        widthTrackRef.current.jump(targetW);
        heightTrackRef.current.jump(targetH);
        radiusTrackRef.current.jump(targetR);
        applyFrameStyles(false);
        return;
      }

      const wResponse = isExp ? 0.24 : ISLAND_CLOSE_RESPONSE;
      const hResponse = isExp ? ISLAND_OPEN_RESPONSE : ISLAND_CLOSE_RESPONSE;
      const rResponse = isExp ? 0.27 : ISLAND_CLOSE_RESPONSE;
      const damping = isExp ? ISLAND_OPEN_DAMPING : ISLAND_CLOSE_DAMPING;

      widthTrackRef.current.springTo(targetW, wResponse, damping);
      heightTrackRef.current.springTo(targetH, hResponse, damping);
      radiusTrackRef.current.springTo(targetR, rResponse, damping);

      ensurePhysicsLoop();
    },
    [applyFrameStyles, ensurePhysicsLoop, getMaxExpandedWidth]
  );

  const openIsland = useCallback(
    (opts?: { silent?: boolean }) => {
      if (foldTimerRef.current) {
        window.clearTimeout(foldTimerRef.current);
        foldTimerRef.current = null;
      }

      const alreadyOpen = expandedRef.current;
      if (supernovaActiveRef.current) {
        supernovaActiveRef.current = false;
        supernovaRevealAlphaRef.current = 1;
        introOrbPoseRef.current = null;
        setSupernovaIntro((prev) => (prev.active ? { ...prev, active: false } : prev));
      }
      if (startupIntroActiveRef.current) {
        startupIntroActiveRef.current = false;
        startupUnfurlStartedRef.current = true;
        shellRef.current?.classList.remove("is-launching");
      }
      if (isExpandingPillContentRef.current) {
        commitPendingPillContentRef.current?.();
      }
      expandedRef.current = true;
      pillHoveredRef.current = false;
      proximityRef.current = 1;
      expOrbActiveRef.current = true;
      expOrbWakeRef.current?.();
      syncDomShellFlags();

      if (!embeddedPreview) {
        const targetExpW = getMaxExpandedWidth();
        const targetExpH = expandedHeightRef.current;
        const { rx, ry } = computeZoneRect(targetExpW, targetExpH);
        pushHitRectIfNeeded(rx, ry, targetExpW, targetExpH, true);
        if (!alreadyOpen) {
          void novaApi.setIslandExpanded(true, snapZoneRef.current, monitorIndexRef.current);
        }
      }

      if (!alreadyOpen && !opts?.silent) {
        playNovaCue("island_open", soundEnabledRef.current);
      }

      retargetGeometry();

      if (!alreadyOpen) {
        // Defer background telemetry/port refresh until AFTER the spring settles so Frame 0 stays 100% stutter-free
        if (refreshTimerRef.current) window.clearTimeout(refreshTimerRef.current);
        refreshTimerRef.current = window.setTimeout(() => {
          refreshTimerRef.current = null;
          if (expandedRef.current) onRefreshSystem();
        }, 460);
      }
    },
    [
      computeZoneRect,
      embeddedPreview,
      getMaxExpandedWidth,
      onRefreshSystem,
      pushHitRectIfNeeded,
      retargetGeometry,
      syncDomShellFlags,
    ]
  );

  const closeIsland = useCallback(
    (opts?: { force?: boolean; silent?: boolean }) => {
      if (foldTimerRef.current) {
        window.clearTimeout(foldTimerRef.current);
        foldTimerRef.current = null;
      }
      if (refreshTimerRef.current) {
        window.clearTimeout(refreshTimerRef.current);
        refreshTimerRef.current = null;
      }
      if (!opts?.force && pendingCountRef.current > 0) {
        return;
      }

      const wasOpen = expandedRef.current;
      suppressCollapseUntilMainReturnRef.current = false;
      setProjectMenuOpen(false);
      expandedRef.current = false;
      pillHoveredRef.current = false;
      proximityRef.current = 0;
      // Freeze the outgoing expanded orb canvas immediately so expandedLayer stays a 100% static GPU texture during collapse
      expOrbActiveRef.current = false;
      pillOrbActiveRef.current = true;
      pillOrbWakeRef.current?.();
      syncDomShellFlags();

      if (!embeddedPreview) {
        const pillW = pillWidthRef.current;
        const { rx, ry } = computeZoneRect(pillW, PILL_HEIGHT);
        pushHitRectIfNeeded(rx, ry, pillW, PILL_HEIGHT, true);
        if (wasOpen) {
          void novaApi.setIslandExpanded(false, snapZoneRef.current, monitorIndexRef.current);
        }
      }

      if (wasOpen && !opts?.silent) {
        playNovaCue("island_close", soundEnabledRef.current);
      }

      retargetGeometry();
    },
    [computeZoneRect, embeddedPreview, pushHitRectIfNeeded, retargetGeometry, syncDomShellFlags]
  );

  const enterHover = useCallback(() => {
    if (supernovaActiveRef.current) return;
    pointerInsideRef.current = true;

    if (nativeDialogOpenRef.current) return;

    if (foldTimerRef.current) {
      window.clearTimeout(foldTimerRef.current);
      foldTimerRef.current = null;
    }

    if (expandedRef.current) return;
    if (suppressFullscreenRef.current && pendingCountRef.current === 0) {
      return;
    }
    openIsland();
  }, [openIsland]);

  // When a popover option is selected while the cursor sits outside the main island
  // (e.g. a modal opened below due to compact height), disable collapse until the cursor
  // moves back onto the main island; if already inside the main island, keep normal collapse.
  useEffect(() => {
    const onPopoverSelect = (event: Event) => {
      if (!expandedRef.current) return;
      const detail = (event as CustomEvent<IslandPopoverSelectDetail>).detail;
      const mainRect = getSettledMainIslandRect();
      const shouldSuppress = resolvePopoverSelectCollapseLock(
        detail?.clientX ?? -1,
        detail?.clientY ?? -1,
        lastPointerPosRef.current,
        mainRect
      );
      suppressCollapseUntilMainReturnRef.current = shouldSuppress;
      if (shouldSuppress) {
        if (foldTimerRef.current) {
          window.clearTimeout(foldTimerRef.current);
          foldTimerRef.current = null;
        }
      } else {
        pointerInsideRef.current = true;
      }
    };
    window.addEventListener(ISLAND_POPOVER_SELECT_EVENT, onPopoverSelect);
    return () => window.removeEventListener(ISLAND_POPOVER_SELECT_EVENT, onPopoverSelect);
  }, [getSettledMainIslandRect]);

  const leaveHover = useCallback(() => {
    if (!pointerInsideRef.current && !expandedRef.current) return;
    if (nativeDialogOpenRef.current) {
      pointerInsideRef.current = false;
      return;
    }
    if (suppressCollapseUntilMainReturnRef.current) {
      if (foldTimerRef.current) {
        window.clearTimeout(foldTimerRef.current);
        foldTimerRef.current = null;
      }
      return;
    }
    pointerInsideRef.current = false;

    if (!expandedRef.current) {
      if (pillHoveredRef.current) {
        pillHoveredRef.current = false;
        proximityRef.current = 0;
        syncDomShellFlags();
      }
      return;
    }

    if (pendingCountRef.current > 0) return;
    if (foldTimerRef.current) window.clearTimeout(foldTimerRef.current);
    const sendTransitionHoldMs = Math.max(0, keepOpenAfterSendUntilRef.current - Date.now());
    foldTimerRef.current = window.setTimeout(() => {
      foldTimerRef.current = null;
      if (pointerInsideRef.current) return;
      closeIsland();
    }, Math.max(collapseDelayMsRef.current, sendTransitionHoldMs));
  }, [closeIsland, retargetGeometry, syncDomShellFlags]);

  useEffect(() => listenForNativeDialogState((open) => {
    nativeDialogOpenRef.current = open;
    if (open) {
      if (foldTimerRef.current) window.clearTimeout(foldTimerRef.current);
      foldTimerRef.current = null;
      return;
    }
    keepOpenAfterSendUntilRef.current = Math.max(keepOpenAfterSendUntilRef.current, Date.now() + 900);
    if (!pointerInsideRef.current) leaveHover();
  }), [leaveHover]);

  // Pre-warm interactive WebAudio + WASAPI keep-alive so hover cues fire with zero cold-start delay
  useEffect(() => {
    if (embeddedPreview) return;
    warmNovaAudio(settings.soundEnabled);
  }, [embeddedPreview, settings.soundEnabled]);

  const enterSupernovaSingularity = useCallback(() => {
    supernovaActiveRef.current = true;
    supernovaRevealAlphaRef.current = 1;
    pushHitRectIfNeeded(0, 0, 0, 0, true);
    if (shellRef.current) {
      shellRef.current.style.width = `${PILL_HEIGHT}px`;
      shellRef.current.style.height = `${PILL_HEIGHT}px`;
      shellRef.current.style.borderRadius = `${PILL_RADIUS}px`;
      shellRef.current.style.backgroundColor = "rgba(14, 14, 17, 0)";
      shellRef.current.style.borderColor = "rgba(255, 255, 255, 0)";
      shellRef.current.style.overflow = "visible";
      shellRef.current.style.pointerEvents = "none";
    }
    if (shadowRef.current) shadowRef.current.style.opacity = "0";
    if (pillLayerRef.current) {
      pillLayerRef.current.style.width = "";
      pillLayerRef.current.style.opacity = "0";
      pillLayerRef.current.style.visibility = "hidden";
    }
    if (expandedLayerRef.current) {
      expandedLayerRef.current.style.visibility = "visible";
      expandedLayerRef.current.style.opacity = "0";
      expandedLayerRef.current.style.pointerEvents = "none";
    }
  }, [pushHitRectIfNeeded]);

  // Atomic pre-paint handoff whenever SupernovaIntroOverlay finishes (`active: true -> false`):
  // Runs AFTER child <NovaOrb size={24}>'s useLayoutEffect has already resized & painted the 24px
  // canvas and BEFORE Blink paints a single frame — completely impossible to flash a 96px orb!
  const prevSupernovaActiveStateRef = useRef(false);
  useLayoutEffect(() => {
    const wasActive = prevSupernovaActiveStateRef.current;
    prevSupernovaActiveStateRef.current = supernovaIntro.active;
    if (!wasActive || supernovaIntro.active) return;

    supernovaActiveRef.current = false;
    supernovaRevealAlphaRef.current = 1;
    introOrbPoseRef.current = null;
    if (shellRef.current) {
      shellRef.current.style.backgroundColor = "";
      shellRef.current.style.borderColor = "";
      shellRef.current.style.overflow = "";
    }
    if (closedStatusRef.current) {
      closedStatusRef.current.style.opacity = "";
      closedStatusRef.current.style.transform = "";
    }
    const finishedOrb = pillMeasureRef.current?.querySelector(
      ".nova-pill-orb-slot > canvas, .nova-pill-orb-slot > .nova-hud-glyph"
    ) as HTMLElement | null;
    if (finishedOrb) {
      finishedOrb.style.transform = "";
      finishedOrb.style.transformOrigin = "";
    }
    if (!expandedRef.current) {
      widthTrackRef.current.jump(pillWidthRef.current);
      heightTrackRef.current.jump(PILL_HEIGHT);
      radiusTrackRef.current.jump(PILL_RADIUS);
      pillOrbActiveRef.current = true;
      pillOrbWakeRef.current?.();
    }
    syncDomShellFlags();
    applyFrameStyles(false);
  }, [applyFrameStyles, supernovaIntro.active, syncDomShellFlags]);

  // Listen for "Replay Intro" trigger from Settings Hub
  useEffect(() => {
    if (embeddedPreview) return;
    let unlisten: (() => void) | undefined;
    void novaApi
      .onReplayIntro(() => {
        if (expandedRef.current) {
          closeIsland({ force: true, silent: true });
        }
        widthTrackRef.current.jump(pillWidthRef.current);
        heightTrackRef.current.jump(PILL_HEIGHT);
        radiusTrackRef.current.jump(PILL_RADIUS);
        enterSupernovaSingularity();
        setSupernovaIntro((prev) => ({ active: true, key: prev.key + 1 }));
      })
      .then((fn) => {
        unlisten = fn;
      });
    return () => {
      unlisten?.();
    };
  }, [closeIsland, embeddedPreview, enterSupernovaSingularity]);

  // Measure natural pill width & expanded content height continuously via ResizeObserver
  useLayoutEffect(() => {
    const sizerEl = pillSizerRef.current ?? pillMeasureRef.current;
    const expEl = expandedMeasureRef.current;
    vpSizeRef.current = {
      w: window.innerWidth || 900,
      h: window.innerHeight || 690,
    };

    const measureTargetPillWidth = () => {
      if (!sizerEl) return pillWidthRef.current;
      return clamp(
        Math.ceil(sizerEl.offsetWidth) + PILL_BREATHING_EXTRA_PX,
        MIN_PILL_WIDTH,
        MAX_PILL_WIDTH
      );
    };

    const syncPillWidth = () => {
      if (!sizerEl) return;
      const measured = measureTargetPillWidth();
      if (Math.abs(measured - pillWidthRef.current) >= 1) {
        const firstMeasure =
          pillWidthRef.current === MIN_PILL_WIDTH && !widthTrackRef.current.animating;
        pillWidthRef.current = measured;
        if (!expandedRef.current && !startupIntroActiveRef.current && !supernovaActiveRef.current) {
          retargetGeometry({ immediate: firstMeasure });
        }
      }
    };

    const syncExpandedHeight = () => {
      if (!expEl) return;
      const rawH = Math.ceil(expEl.offsetHeight);
      const clampedH = clamp(rawH, 160, MAX_EXPANDED_HEIGHT);
      if (Math.abs(clampedH - expandedHeightRef.current) >= 1) {
        expandedHeightRef.current = clampedH;
        if (expandedRef.current) {
          if (!embeddedPreview) {
            const targetExpW = getMaxExpandedWidth();
            const { rx, ry } = computeZoneRect(targetExpW, clampedH);
            pushHitRectIfNeeded(rx, ry, targetExpW, clampedH, true);
          }
          retargetGeometry();
        }
      }
    };

    syncDomShellFlags();
    syncPillWidth();
    syncExpandedHeight();
    applyFrameStyles(false);

    if (!startupIntroPlayedRef.current && !embeddedPreview) {
      startupIntroPlayedRef.current = true;
      const introMode = settings.startupIntro ?? "cinematic";
      const tauriMode = isTauriRuntime();

      if (tauriMode) {
        // Pre-warm ALL expanded GPU raster tiles, Skia rounded-rect shaders, glyph atlases, and
        // Lucide SVG layers during 1 hidden frame BEFORE the Win32 stage window is revealed —
        // making the very first hover expand & collapse 100% as smooth as the 10th hover!
        const shell = shellRef.current;
        const expLayer = expandedLayerRef.current;
        const warmW = getMaxExpandedWidth();
        const warmH = expandedHeightRef.current;
        if (shell && expLayer) {
          shell.style.width = `${warmW}px`;
          shell.style.height = `${warmH}px`;
          shell.style.borderRadius = `${EXPANDED_RADIUS}px`;
          expLayer.style.width = `${warmW}px`;
          expLayer.style.visibility = "visible";
          expLayer.style.opacity = "0.02";
          if (topbarRef.current) topbarRef.current.style.opacity = "1";
          if (islandBodyRef.current) islandBodyRef.current.style.opacity = "1";
        }
        if (!prefersReducedMotion() && introMode === "cinematic") {
          supernovaActiveRef.current = true;
        }

        window.requestAnimationFrame(() => {
          if (!prefersReducedMotion() && introMode !== "off") {
            if (introMode === "cinematic") {
              enterSupernovaSingularity();
              setSupernovaIntro((prev) => ({ active: true, key: prev.key + 1 }));
            } else {
              supernovaActiveRef.current = false;
              startupIntroActiveRef.current = true;
              startupUnfurlStartedRef.current = false;
              startupIntroStartedAtRef.current = performance.now();
              widthTrackRef.current.jump(PILL_HEIGHT);
              heightTrackRef.current.jump(PILL_HEIGHT);
              radiusTrackRef.current.jump(PILL_RADIUS);
              shellRef.current?.classList.add("is-launching");
              applyFrameStyles(true);
              ensurePhysicsLoop();
            }
          } else {
            supernovaActiveRef.current = false;
            applyFrameStyles(false);
          }

          window.requestAnimationFrame(() => {
            void novaApi.revealIslandWindow();
          });
        });
      }
    }

    const ro = new ResizeObserver(() => {
      syncPillWidth();
      syncExpandedHeight();
    });
    if (sizerEl) ro.observe(sizerEl);
    if (expEl) ro.observe(expEl);

    const onWinResize = () => {
      vpSizeRef.current = {
        w: window.innerWidth || 900,
        h: window.innerHeight || 690,
      };
      if (expandedRef.current) retargetGeometry();
      else applyFrameStyles(false);
    };
    window.addEventListener("resize", onWinResize);

    return () => {
      ro.disconnect();
      window.removeEventListener("resize", onWinResize);
    };
  }, [
    applyFrameStyles,
    computeZoneRect,
    embeddedPreview,
    enterSupernovaSingularity,
    ensurePhysicsLoop,
    getMaxExpandedWidth,
    pushHitRectIfNeeded,
    retargetGeometry,
    syncDomShellFlags,
  ]);

  // Stage folded-pill text transitions so when status text grows longer, the island capsule
  // springs wider FIRST and reveals the longer text only once the island covers it.
  useLayoutEffect(() => {
    pendingClosedStatusRef.current = liveClosedStatus;
    const sizerEl = pillSizerRef.current;
    const nextW = sizerEl
      ? clamp(
          Math.ceil(sizerEl.offsetWidth) + PILL_BREATHING_EXTRA_PX,
          MIN_PILL_WIDTH,
          MAX_PILL_WIDTH
        )
      : pillWidthRef.current;
    const curW = widthTrackRef.current.value;
    const textChanged =
      liveClosedStatus.text !== displayedClosedStatus.text ||
      liveClosedStatus.cls !== displayedClosedStatus.cls;

    const shouldExpandIslandFirst =
      textChanged &&
      !expandedRef.current &&
      !supernovaActiveRef.current &&
      !startupIntroActiveRef.current &&
      !prefersReducedMotion() &&
      heightTrackRef.current.value <= PILL_HEIGHT + 0.5 &&
      nextW > curW + 4;

    if (shouldExpandIslandFirst) {
      pillExpandStartWRef.current = curW;
      pillWidthRef.current = nextW;
      isExpandingPillContentRef.current = true;
      setPillAwaitingExpand(true);
      if (!embeddedPreview) {
        const { rx, ry } = computeZoneRect(nextW, PILL_HEIGHT);
        pushHitRectIfNeeded(rx, ry, nextW, PILL_HEIGHT, true);
      }
      widthTrackRef.current.springTo(nextW, 0.2, ISLAND_OPEN_DAMPING);
      ensurePhysicsLoop();
      return;
    }

    if (!isExpandingPillContentRef.current) {
      if (textChanged) {
        setDisplayedClosedStatus(liveClosedStatus);
        setPillAwaitingExpand(false);
        if (!supernovaActiveRef.current && !startupIntroActiveRef.current) {
          setPillTextAnimSeq((seq) => seq + 1);
        }
      }
      if (Math.abs(nextW - pillWidthRef.current) >= 1) {
        pillWidthRef.current = nextW;
        if (!expandedRef.current && !startupIntroActiveRef.current && !supernovaActiveRef.current) {
          retargetGeometry();
        }
      }
    } else if (nextW <= curW + 4) {
      pillWidthRef.current = nextW;
      commitPendingPillContentRef.current?.();
      if (!expandedRef.current && !startupIntroActiveRef.current && !supernovaActiveRef.current) {
        retargetGeometry();
      }
    }
  }, [
    computeZoneRect,
    displayedClosedStatus.cls,
    displayedClosedStatus.text,
    embeddedPreview,
    ensurePhysicsLoop,
    liveClosedStatus,
    pushHitRectIfNeeded,
    retargetGeometry,
  ]);

  // Keep staged body transform synced whenever switching tabs while expanded
  useLayoutEffect(() => {
    applyFrameStyles();
  }, [activeTab, applyFrameStyles]);

  // Cleanup timers & rAF on unmount
  useEffect(() => {
    return () => {
      if (rafIdRef.current) window.cancelAnimationFrame(rafIdRef.current);
      if (foldTimerRef.current) window.clearTimeout(foldTimerRef.current);
      if (refreshTimerRef.current) window.clearTimeout(refreshTimerRef.current);
    };
  }, []);

  // Auto-open whenever an urgent approval or interactive agent question arrives
  useEffect(() => {
    if (totalUrgentCount > 0) {
      setActiveTab("mission");
      openIsland({ silent: true });
      if (pendingQuestions.length > 0) {
        const latestQ = pendingQuestions[0];
        if (latestQ?.workspacePath) {
          setSelectedWorkspacePath(latestQ.workspacePath);
        }
        if (latestQ?.conversationId) {
          setSelectedSessionId(latestQ.conversationId);
          setIsNewChatDraft(false);
        }
        if (!embeddedPreview) {
          void novaApi.focusIslandWindow();
        }
      }
    }
  }, [embeddedPreview, openIsland, pendingQuestions, totalUrgentCount]);

  // Reposition Tauri stage window ONLY when snapZone or monitorIndex changes in settings
  useEffect(() => {
    if (embeddedPreview) return;
    void novaApi.setIslandExpanded(
      expandedRef.current,
      settings.snapZone,
      settings.monitorIndex
    );
    applyFrameStyles();
  }, [settings.snapZone, settings.monitorIndex, embeddedPreview, applyFrameStyles]);

  // Authoritative Win32 cursor hit-tester events in Tauri desktop mode.
  // Keep a permanent single-mount subscription backed by a ref so re-renders never create
  // async unlisten/re-listen dead windows where pointer transitions could be missed.
  const islandPointerHandlerRef = useRef<
    (payload: {
      inside: boolean;
      on_main?: boolean;
      fullscreen?: boolean;
      x: number;
      y: number;
      proximity?: number;
    }) => void
  >(() => {});

  islandPointerHandlerRef.current = ({
    inside,
    on_main,
    fullscreen,
    x,
    y,
    proximity = 0,
  }) => {
    lastPointerPosRef.current = { x, y };
    if (typeof fullscreen === "boolean" && (inside || proximity > 0)) {
      liveFullscreenRef.current = fullscreen;
      suppressFullscreenRef.current = Boolean(
        suppressFullscreenSettingRef.current && fullscreen
      );
    }

    const mainRect = getSettledMainIslandRect();
    const onMain =
      typeof on_main === "boolean"
        ? on_main
        : x >= mainRect.x &&
          x <= mainRect.x + mainRect.w &&
          y >= mainRect.y &&
          y <= mainRect.y + mainRect.h;

    const step = stepIslandPointerHoverState({
      inside,
      onMain,
      suppressCollapseUntilMainReturn: suppressCollapseUntilMainReturnRef.current,
      pointerInside: pointerInsideRef.current,
    });
    suppressCollapseUntilMainReturnRef.current = step.nextSuppressCollapse;

    if (step.action === "enter") {
      if (supernovaActiveRef.current && !expandedRef.current) {
        // Once the intro capsule has docked into the top pill slot, allow immediate hover open
        openIsland();
        return;
      }
      enterHover();
      return;
    }
    if (step.action === "hold") {
      if (foldTimerRef.current) {
        window.clearTimeout(foldTimerRef.current);
        foldTimerRef.current = null;
      }
      return;
    }
    if (step.action === "leave") {
      leaveHover();
    }

    // Subtle GPU pre-wake scale + border highlight ONLY when resting folded (zero layout
    // resize, zero IPC feedback loop, and never allowed to interrupt an active collapse)
    if (
      !expandedRef.current &&
      !isMorphingRef.current &&
      !startupIntroActiveRef.current &&
      !supernovaActiveRef.current &&
      !(suppressFullscreenRef.current && pendingCountRef.current === 0)
    ) {
      const nextProx = clamp(proximity, 0, 1);
      const nextNear = nextProx > 0.12;
      const gatedProx = nextNear ? nextProx : 0;
      if (
        Math.abs(gatedProx - proximityRef.current) > 0.012 ||
        (gatedProx === 0 && proximityRef.current !== 0)
      ) {
        proximityRef.current = gatedProx;
        applyFrameStyles(false);
      }
      if (nextNear !== pillHoveredRef.current) {
        if (nextNear) warmNovaAudio(soundEnabledRef.current);
        pillHoveredRef.current = nextNear;
        syncDomShellFlags();
      }
    }
  };

  useEffect(() => {
    if (embeddedPreview) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void novaApi
      .onIslandPointer((payload) => islandPointerHandlerRef.current(payload))
      .then((fn) => {
        if (disposed) {
          fn();
        } else {
          unlisten = fn;
        }
      });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [embeddedPreview]);

  // Global keyboard shortcut inside window (`Ctrl+Alt+Space` / `Ctrl+K` / `Escape`)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && expandedRef.current) {
        closeIsland({ force: totalUrgentCount === 0 });
      }
      if (
        (e.ctrlKey && e.altKey && e.code === "Space") ||
        (e.ctrlKey && e.key.toLowerCase() === "k")
      ) {
        e.preventDefault();
        openIsland();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
    };
  }, [closeIsland, openIsland, totalUrgentCount]);

  const useNativePointerPoll = !embeddedPreview && isTauriRuntime();

  // Mirror the exact multi-rect + post-select hover state machine in browser / non-Tauri mode
  useEffect(() => {
    if (embeddedPreview || useNativePointerPoll) return;
    const onPointerMove = (e: PointerEvent) => {
      lastPointerPosRef.current = { x: e.clientX, y: e.clientY };
      if (!expandedRef.current) return;
      const shellRect = shellRef.current?.getBoundingClientRect();
      const mainRect: HoverRect = shellRect
        ? { x: shellRect.left, y: shellRect.top, w: shellRect.width, h: shellRect.height }
        : getSettledMainIslandRect();
      const extraRects = collectPopoverExtraRects(mainRect);
      const hit = hitTestIslandRegions(e.clientX, e.clientY, mainRect, extraRects, true);
      const step = stepIslandPointerHoverState({
        inside: hit.inside,
        onMain: hit.onMain,
        suppressCollapseUntilMainReturn: suppressCollapseUntilMainReturnRef.current,
        pointerInside: pointerInsideRef.current,
      });
      suppressCollapseUntilMainReturnRef.current = step.nextSuppressCollapse;
      if (step.action === "enter") {
        enterHover();
      } else if (step.action === "hold") {
        if (foldTimerRef.current) {
          window.clearTimeout(foldTimerRef.current);
          foldTimerRef.current = null;
        }
      } else if (step.action === "leave") {
        leaveHover();
      }
    };
    window.addEventListener("pointermove", onPointerMove, { passive: true });
    return () => window.removeEventListener("pointermove", onPointerMove);
  }, [collectPopoverExtraRects, embeddedPreview, enterHover, getSettledMainIslandRect, leaveHover, useNativePointerPoll]);

  const handleShellPointerEnter = (e: React.MouseEvent) => {
    if (embeddedPreview) return;
    lastPointerPosRef.current = { x: e.clientX, y: e.clientY };
    if (useNativePointerPoll) {
      // Instant zero-IPC backup when folded: Win32 only delivers mouseenter once the cursor is
      // already inside the pill hit-rect and passthrough has been disabled.
      if (!expandedRef.current) {
        enterHover();
      }
      return;
    }
    suppressCollapseUntilMainReturnRef.current = false;
    enterHover();
  };

  const handleShellPointerLeave = (e: React.MouseEvent) => {
    // In Tauri desktop overlay, Win32 GetCursorPos (`onIslandPointer`) handles leave so native
    // <select> popups or child transitions never trigger false mouseleave folds.
    if (useNativePointerPoll || embeddedPreview) return;
    lastPointerPosRef.current = { x: e.clientX, y: e.clientY };
    const shellRect = shellRef.current?.getBoundingClientRect();
    const mainRect: HoverRect = shellRect
      ? { x: shellRect.left, y: shellRect.top, w: shellRect.width, h: shellRect.height }
      : getSettledMainIslandRect();
    const extraRects = collectPopoverExtraRects(mainRect);
    const relatedInPopover =
      e.relatedTarget instanceof Element &&
      Boolean(e.relatedTarget.closest("[data-nova-island-hover-region='true']"));
    const hit = hitTestIslandRegions(
      e.clientX,
      e.clientY,
      mainRect,
      extraRects,
      expandedRef.current
    );
    const step = stepIslandPointerHoverState({
      inside: hit.inside || relatedInPopover,
      onMain: hit.onMain,
      suppressCollapseUntilMainReturn: suppressCollapseUntilMainReturnRef.current,
      pointerInside: pointerInsideRef.current,
    });
    suppressCollapseUntilMainReturnRef.current = step.nextSuppressCollapse;
    if (step.action === "leave") {
      leaveHover();
    }
  };

  const allProjectPaths = [
    ...(snapshot.recentWorkspaces ?? []).map((workspace) => workspace.path),
    ...cliSessions.map((session) => session.workspacePath),
    ...recentProjectPaths,
    ...addedWorkspacePaths,
  ].reduce<string[]>((unique, path) => {
    if (path && !unique.some((existing) => existing.toLowerCase() === path.toLowerCase())) unique.push(path);
    return unique;
  }, []);
  const projectPaths = allProjectPaths.filter((path) => !hiddenProjectPaths.some((hidden) => hidden.toLowerCase() === path.toLowerCase()));
  const activeWorkspacePath = (selectedWorkspacePath && projectPaths.some((path) => path.toLowerCase() === selectedWorkspacePath.toLowerCase())
    ? selectedWorkspacePath
    : projectPaths[0]) ?? "";
  const workspaceSessions = cliSessions.filter((session) =>
    session.workspacePath.toLowerCase() === activeWorkspacePath.toLowerCase() &&
    !hiddenChatIds.includes(session.conversationId)
  );
  const selectedSession = isNewChatDraft
    ? null
    : selectedSessionId
      ? workspaceSessions.find((session) => session.conversationId === selectedSessionId) || null
      : workspaceSessions[0] || null;

  useEffect(() => {
    if (activeWorkspacePath && !isNewChatDraft && selectedSessionId && !selectedSession) {
      setSelectedSessionId(null);
      setIsNewChatDraft(true);
    }
  }, [activeWorkspacePath, isNewChatDraft, selectedSessionId, selectedSession?.conversationId]);

  useLayoutEffect(() => {
    if (!projectMenuOpen) {
      setProjectMenuPosition(null);
      return;
    }
    const rect = projectSwitcherRef.current?.getBoundingClientRect();
    if (!rect) return;
    const rawHeight = projectMenuRef.current?.scrollHeight ?? 180;
    const desiredHeight = Math.min(280, rawHeight);
    const menuWidth = projectMenuRef.current?.offsetWidth || 260;
    const placement = computePopoverPlacement({
      triggerRect: rect,
      desiredHeight,
      menuWidth,
      viewportW: window.innerWidth,
      viewportH: window.innerHeight,
      gap: 8,
      margin: 8,
    });
    setProjectMenuPosition({
      top: placement.top,
      left: placement.left,
      maxHeight: Math.max(72, Math.min(280, placement.availableHeight)),
    });
  }, [projectMenuOpen, projectPaths.length]);

  useLayoutEffect(() => {
    if (!projectMenuOpen || !projectMenuPosition) return;
    const notify = () => window.dispatchEvent(new Event(ISLAND_HOVER_REGION_EVENT));
    notify();
    const el = projectMenuRef.current;
    const ro =
      el && typeof ResizeObserver !== "undefined" ? new ResizeObserver(notify) : null;
    if (el && ro) ro.observe(el);
    return () => {
      ro?.disconnect();
      notify();
    };
  }, [projectMenuOpen, projectMenuPosition]);

  useEffect(() => {
    if (!projectMenuOpen) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (
        !projectSwitcherRef.current?.contains(event.target as Node) &&
        !projectMenuRef.current?.contains(event.target as Node)
      ) {
        setProjectMenuOpen(false);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setProjectMenuOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [projectMenuOpen]);

  useEffect(() => {
    if (activeTab !== "mission" || pendingQuestions.length > 0) return;
    let timer = 0;
    let cancelled = false;
    const focusComposer = (retries: number) => {
      if (cancelled) return;
      const input = document.querySelector<HTMLTextAreaElement>(".nova-mission-full textarea.cockpit-input");
      if (input) {
        input.focus({ preventScroll: true });
        const cursor = input.value.length;
        input.setSelectionRange(cursor, cursor);
      } else if (retries > 0) {
        timer = window.setTimeout(() => focusComposer(retries - 1), 40);
      }
    };
    timer = window.setTimeout(() => focusComposer(6), 30);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [activeTab, activeWorkspacePath, isNewChatDraft, pendingQuestions.length, selectedSession?.conversationId]);

  const activeThread =
    snapshot.threads.find((thread) => thread.id === activeThreadId) ??
    (activeThreadId ? null : snapshot.threads[0] || null);
  const chatWorkspacePath = selectedWorkspacePath || activeThread?.workspacePath || "";

  const selectWorkspaceForMission = (workspacePath: string) => {
    const projectSessions = sessions.filter((session) => session.workspacePath.toLowerCase() === workspacePath.toLowerCase() && !hiddenChatIds.includes(session.conversationId));
    setRecentProjectPaths(rememberRecentProjectPath(workspacePath));
    setHiddenProjectPaths((hidden) => {
      const next = hidden.filter((path) => path.toLowerCase() !== workspacePath.toLowerCase());
      try { localStorage.setItem("nova_hidden_project_tabs", JSON.stringify(next)); } catch {}
      return next;
    });
    setSelectedWorkspacePath(workspacePath);
    setProjectMenuOpen(false);
    setAddedWorkspacePaths((paths) => paths.some((path) => path.toLowerCase() === workspacePath.toLowerCase()) ? paths : [...paths, workspacePath]);
    setSelectedSessionId(null);
    setIsNewChatDraft(true);
    setChatInput("");
  };

  const closeProjectTab = (workspacePath: string) => {
    setProjectMenuOpen(false);
    const nextHidden = [...hiddenProjectPaths.filter((path) => path.toLowerCase() !== workspacePath.toLowerCase()), workspacePath];
    setHiddenProjectPaths(nextHidden);
    setAddedWorkspacePaths((paths) => paths.filter((path) => path.toLowerCase() !== workspacePath.toLowerCase()));
    try { localStorage.setItem("nova_hidden_project_tabs", JSON.stringify(nextHidden)); } catch {}
    if (activeWorkspacePath.toLowerCase() === workspacePath.toLowerCase()) {
      const nextProject = projectPaths.find((path) => path.toLowerCase() !== workspacePath.toLowerCase());
      if (nextProject) selectWorkspaceForMission(nextProject);
      else {
        setSelectedWorkspacePath("");
        setSelectedSessionId(null);
        setIsNewChatDraft(false);
      }
    }
  };

  const closeChatTab = (conversationId: string) => {
    const nextHidden = [...hiddenChatIds.filter((id) => id !== conversationId), conversationId];
    setHiddenChatIds(nextHidden);
    try { localStorage.setItem("nova_hidden_chat_tabs", JSON.stringify(nextHidden)); } catch {}
    if (selectedSessionId === conversationId) {
      const nextSession = workspaceSessions.find((session) => session.conversationId !== conversationId);
      setSelectedSessionId(nextSession?.conversationId ?? null);
      setIsNewChatDraft(false);
    }
  };

  const addProjectFromFolder = async () => {
    setProjectMenuOpen(false);
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const selected = await withNativeDialog(() => open({ directory: true, multiple: false, title: lang === "th" ? "เลือกโฟลเดอร์โปรเจกต์" : "Select project folder" }));
      if (typeof selected === "string") selectWorkspaceForMission(selected);
    } catch {
      // The project picker remains available on the empty state if the native dialog cannot open.
    }
  };

  const createChatThread = async () => {
    const result = await novaApi.newChatThread(undefined, selectedWorkspacePath || undefined);
    if (result.ok) setActiveThreadId(result.threadId);
  };

  const handleSendChat = async () => {
    if (!chatInput.trim() && !snipPreview) return;
    const threadId = activeThread?.id ?? activeThreadId ?? "thread-main";
    const text = chatInput.trim() || "Analyze this captured screen context.";
    setChatInput("");
    setChatSending(true);
    await novaApi.sendChat({
      threadId,
      content: text,
      provider: settings.defaultChatProvider,
      model: settings.defaultChatModel,
      workspacePath: chatWorkspacePath || undefined,
      imageDataUrl: snipPreview,
      attachedFile: droppedFilePath,
    });
    setSnipPreview(null);
    setDroppedFilePath(null);
    setChatSending(false);
  };

  const handleScreenSnip = async () => {
    const res = await novaApi.captureScreenSnip();
    if (res.ok && res.dataUrl) {
      setSnipPreview(res.dataUrl);
      setActiveTab("chat");
    }
  };

  const formatTimer = (sec: number) => {
    const m = String(Math.floor(sec / 60)).padStart(2, "0");
    const s = String(sec % 60).padStart(2, "0");
    return `${m}:${s}`;
  };

  // Account, Quota & Model logic (used in Quick Chat tab)
  const activeAccount = settings.activeAccount === "second" ? "second" : "main";
  const mainName = settings.mainAccountName || "Main Account";
  const secondName = settings.secondAccountName || "Second Account";
  const activeAccountName = activeAccount === "second" ? secondName : mainName;

  const quota = snapshot.quota;
  const activeQuota = activeAccount === "second" ? quota?.second : quota?.main;
  const quotaStatus = activeQuota?.status || "healthy";

  const handleToggleAccount = async (targetAccount?: "main" | "second") => {
    const next = targetAccount ?? (activeAccount === "main" ? "second" : "main");
    playNovaCue("step", settings.soundEnabled);
    await novaApi.switchAccount(next);
  };

  const handleRefreshQuota = async () => {
    await novaApi.refreshQuota();
    playNovaCue("ready", settings.soundEnabled);
  };

  const handleSelectModel = async (modelId: string) => {
    const found = AVAILABLE_MODELS.find((m) => m.id === modelId);
    const newProvider = found ? found.provider : settings.defaultChatProvider;
    await novaApi.saveSettings({
      ...settings,
      defaultChatModel: modelId,
      defaultChatProvider: newProvider,
    });
    playNovaCue("step", settings.soundEnabled);
  };

  const effectiveZone = embeddedPreview ? "top-center" : settings.snapZone;

  return (
    <div
      ref={viewportRef}
      className={`nova-island-viewport zone-${effectiveZone} ${
        embeddedPreview ? "embedded-viewport" : ""
      }`}
      onDragOver={(e) => e.preventDefault()}
      onDrop={async (e) => {
        e.preventDefault();
        const f = e.dataTransfer.files?.[0] as (File & { path?: string }) | undefined;
        if (!f) return;
        if (isSupportedImageFile(f)) {
          const durl = await fileToDataUrl(f);
          if (durl) {
            setSnipPreview(durl);
            setActiveTab("chat");
            openIsland();
            return;
          }
        }
        if (f.path) {
          setDroppedFilePath(f.path);
          setActiveTab("chat");
          openIsland();
        }
      }}
    >
      {!embeddedPreview && (
        <div ref={shadowRef} className="nova-island-shadow" aria-hidden="true" />
      )}
      {!embeddedPreview && supernovaIntro.active && (
        <SupernovaIntroOverlay
          active={supernovaIntro.active}
          runKey={supernovaIntro.key}
          soundEnabled={settings.soundEnabled}
          getPillMetrics={() => {
            const w = pillWidthRef.current;
            const { rx, ry } = computeZoneRect(w, PILL_HEIGHT);
            return { x: rx, y: ry, w, h: PILL_HEIGHT };
          }}
          isBottomDock={effectiveZone === "bottom-dock"}
          idleLabel={t(lang, "idleReady")}
          onIntroFrame={({ elapsed, centerX, heroY, pillX, pillY, pillW, pillH }) => {
            const shell = shellRef.current;
            const shadow = shadowRef.current;
            const pillLayer = pillLayerRef.current;
            const pillMeasure = pillMeasureRef.current;
            if (!shell || !pillLayer || !pillMeasure) return;

            const easeOut3 = (v: number) => 1 - Math.pow(1 - clamp(v, 0, 1), 3);
            const easeInOut3 = (v: number) => {
              const x = clamp(v, 0, 1);
              return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
            };
            const easeOutBackHero = (v: number, overshoot = 1.55) => {
              const x = clamp(v, 0, 1);
              const c3 = overshoot + 1;
              return 1 + c3 * Math.pow(x - 1, 3) + overshoot * Math.pow(x - 1, 2);
            };

            const dockP = clamp((elapsed - 2.42) / 0.66, 0, 1);
            const unfurlP = clamp((elapsed - 3.08) / 0.6, 0, 1);
            const eDock = easeInOut3(dockP);
            const eUnfurl = easeOut3(unfurlP);

            // 1. Real .nova-island-shell: invisible during Acts I & II, materializes at 2.66s as a
            //    dead-center 38x38 circle with violet rim glow, then unfurls to resting pillW!
            const curShellW = pillH + (pillW - pillH) * eUnfurl;
            const curShellX = centerX - curShellW * 0.5;
            const shellReveal = clamp((dockP - 0.36) / 0.44, 0, 1);
            const rimGlow =
              dockP > 0.45 ? Math.sin(clamp((elapsed - 2.8) / 0.85, 0, 1) * Math.PI) : 0;

            shell.style.width = `${curShellW.toFixed(2)}px`;
            shell.style.height = `${pillH}px`;
            shell.style.borderRadius = `${(pillH * 0.5).toFixed(2)}px`;
            shell.style.transform = `translate3d(${curShellX.toFixed(2)}px, ${pillY.toFixed(2)}px, 0)`;
            shell.style.opacity = "1";
            shell.style.pointerEvents = "none";
            // Keep overflow visible while Hero NOVA is larger than 38px; clip right as docking completes
            // BEFORE unfurlP (>3.08s) begins so status text never peeks outside the capsule circle!
            shell.style.overflow = dockP >= 0.94 ? "hidden" : "visible";
            if (dockP >= 0.96) {
              pushHitRectIfNeeded(pillX, pillY, pillW, pillH);
            }

            if (shellReveal <= 0.004) {
              shell.style.backgroundColor = "rgba(14, 14, 17, 0)";
              shell.style.borderColor = "rgba(255, 255, 255, 0)";
            } else {
              const baseBg =
                settings.theme === "tactical"
                  ? `rgba(6, 11, 9, ${shellReveal.toFixed(3)})`
                  : settings.theme === "acrylic"
                  ? `rgba(14, 17, 26, ${shellReveal.toFixed(3)})`
                  : `rgba(14, 14, 17, ${shellReveal.toFixed(3)})`;
              shell.style.backgroundColor = baseBg;
              shell.style.borderColor =
                rimGlow > 0.01
                  ? `rgba(167, 139, 250, ${((0.2 + rimGlow * 0.68) * shellReveal).toFixed(3)})`
                  : `rgba(255, 255, 255, ${(0.13 * shellReveal).toFixed(3)})`;
            }

            if (shadow) {
              const sx = (curShellW + 36) / SHADOW_BASE_W;
              const sy = (pillH + 36) / SHADOW_BASE_H;
              shadow.style.opacity = (0.56 * shellReveal).toFixed(3);
              shadow.style.transform = `translate3d(${(curShellX - 18).toFixed(2)}px, ${(pillY - 8).toFixed(2)}px, 0) scale3d(${sx.toFixed(4)}, ${sy.toFixed(4)}, 1)`;
            }

            // 2. Real <NovaOrb> rendered at native 96x96 CSS px (zero 4x compositor upscale blur!):
            //    hidden during Singularity (<0.86s), pops out of the 0.86s Supernova flash
            //    with sleepy wake -> left/right scan -> happy (^^) smile -> dead-center dock -> left slot glide!
            const orb = pillMeasure.querySelector(
              ".nova-pill-orb-slot > canvas, .nova-pill-orb-slot > .nova-hud-glyph"
            ) as HTMLElement | null;
            if (elapsed < 0.86) {
              pillLayer.style.opacity = "0";
              pillLayer.style.visibility = "hidden";
              introOrbPoseRef.current = {
                active: true,
                yaw: 0,
                pitch: 0.02,
                eyeOpen: 0.08,
                happySmile: 0,
                ringScale: 0.86,
                moonAngle: -1.9,
                moonTrail: 0,
                glowBoost: 0.7,
                blendToLive: 0,
              };
            } else {
              const act2P = clamp((elapsed - 0.86) / 1.56, 0, 1);
              const popScale = elapsed < 2.42 ? easeOutBackHero(clamp(act2P / 0.34, 0, 1), 1.55) : 1;
              const bobY = elapsed < 2.42 ? Math.sin(act2P * Math.PI * 2) * 3.5 * (1 - eDock) : 0;

              let wakeOpen = act2P < 0.16 ? 0.08 : clamp((act2P - 0.16) / 0.14, 0.08, 1);
              // Gentle 60ms blink-in / blink-out around the happy (^^) smile so eyes never snap harshly
              if (elapsed < 2.42) {
                const dIn = Math.abs(act2P - 0.56);
                const dOut = Math.abs(act2P - 0.92);
                const blinkDip = Math.min(dIn, dOut) < 0.038 ? Math.min(dIn, dOut) / 0.038 : 1;
                wakeOpen = Math.min(wakeOpen, 0.12 + 0.88 * blinkDip);
              }
              const yaw =
                elapsed < 2.42 && act2P > 0.28 && act2P < 0.55
                  ? Math.sin(((act2P - 0.28) / 0.27) * Math.PI * 2) * 0.36
                  : 0;
              const smile = elapsed < 2.42 && act2P > 0.56 && act2P < 0.92 ? 1 : 0;
              const moonAngle =
                elapsed < 2.42
                  ? -1.9 + easeOut3(act2P) * 2.48
                  : 0.58 + (elapsed - 2.42) * 0.55;
              const moonTrail =
                elapsed < 2.42 ? Math.sin(clamp(act2P / 0.7, 0, 1) * Math.PI) * 0.85 : 0;

              introOrbPoseRef.current = {
                active: true,
                yaw,
                pitch: smile ? 0.08 : 0.02,
                eyeOpen: wakeOpen,
                happySmile: smile,
                ringScale: 0.86 + 0.14 * easeOut3(clamp(act2P / 0.42, 0, 1)),
                moonAngle,
                moonTrail,
                glowBoost: elapsed < 2.42 ? (1 - act2P) * 0.7 : (1 - eDock) * 0.25,
                blendToLive: easeInOut3(clamp((elapsed - 3.12) / 0.55, 0, 1)),
              };
              pillOrbActiveRef.current = true;
              pillOrbWakeRef.current?.();

              const heroSize = 94 * popScale;
              const curOrbSize = heroSize + (24 - heroSize) * eDock;
              // Scale DOWN from native 96px canvas (0.98x -> 0.25x) so Blink never upscales a 24px GPU tile!
              const orbScale = Math.max(0.05, curOrbSize / 96);

              // Dead-center inside 38x38 circle at eUnfurl=0, gliding to natural resting slot (pillX + 20, pillY + 20) at eUnfurl=1!
              const targetDockX = centerX + (curShellX + 20 - centerX) * eUnfurl;
              const targetDockY = pillY + pillH * 0.5 + (pillY + 20 - (pillY + pillH * 0.5)) * eUnfurl;
              const orbCenterX = centerX + (targetDockX - centerX) * eDock;
              const orbCenterY = heroY + bobY + (targetDockY - (heroY + bobY)) * eDock;

              const tx = orbCenterX - (curShellX + 20);
              const ty = orbCenterY - (pillY + 20);

              pillLayer.style.visibility = "visible";
              pillLayer.style.opacity = "1";
              pillLayer.style.pointerEvents = "none";
              pillLayer.style.transform = `translate3d(${tx.toFixed(2)}px, ${ty.toFixed(2)}px, 0)`;

              if (orb) {
                orb.style.transformOrigin = "50% 50%";
                orb.style.transform = `scale(${orbScale.toFixed(4)})`;
              }
            }

            if (closedStatusRef.current) {
              const labelReveal = clamp((eUnfurl - 0.16) / 0.84, 0, 1);
              closedStatusRef.current.style.opacity = labelReveal.toFixed(3);
              closedStatusRef.current.style.transform = `translate3d(${((1 - labelReveal) * -6).toFixed(2)}px, 0, 0)`;
            }
          }}
          onDockUnfurlProgress={() => {}}
          onComplete={() => {
            // Keep orb at scale(0.25) until React commits size={24} and useLayoutEffect runs pre-paint!
            setSupernovaIntro((prev) => ({ ...prev, active: false }));
          }}
        />
      )}
      <div
        ref={shellRef}
        className={`nova-island-shell ${supernovaIntro.active ? "is-supernova-intro" : ""} theme-${settings.theme} aura-${settings.aura} state-${orbState} ${
          embeddedPreview
            ? "is-expanded is-embedded"
            : expandedRef.current
            ? "is-expanded"
            : "is-folded"
        }${isMorphingRef.current ? " is-morphing" : ""}${
          !expandedRef.current && pillHoveredRef.current ? " is-prewake" : ""
        }`}
        onMouseEnter={handleShellPointerEnter}
        onMouseLeave={handleShellPointerLeave}
        onMouseDownCapture={(e) => {
          const el = e.target as HTMLElement | null;
          if (el?.closest("input, textarea, select, [contenteditable='true']")) {
            void novaApi.focusIslandWindow();
          }
        }}
      >
        {/* LAYER A: COMPACT FOLDED PILL */}
        <div ref={pillLayerRef} className="nova-pill-layer" aria-hidden={embeddedPreview}>
          {/* Offscreen natural-width sizer so pre-paint layout knows incoming width before expanding */}
          <div ref={pillSizerRef} className="nova-pill-measure nova-pill-sizer" aria-hidden="true">
            <div className="nova-pill-orb-slot" />
            <div className="nova-closed-status">
              <span className={`nova-closed-label ${liveClosedStatus.cls}`}>
                {liveClosedStatus.text}
              </span>
              <span className={`nova-pill-waveform state-${orbState}`}>
                <i />
                <i />
                <i />
                <i />
              </span>
            </div>
          </div>

          <div ref={pillMeasureRef} className="nova-pill-measure">
            <div className="nova-pill-orb-slot">
              <NovaOrb
                mode={settings.avatarMode}
                aura={settings.aura}
                state={orbState}
                size={supernovaIntro.active ? 96 : 24}
                renderScale={2}
                activeCount={activeAgentCount}
                activeRef={pillOrbActiveRef}
                wakeRef={pillOrbWakeRef}
                morphingRef={isMorphingRef}
                introPoseRef={introOrbPoseRef}
              />
            </div>
            <div ref={closedStatusRef} className="nova-closed-status">
              <span
                key={pillTextAnimSeq}
                className={`nova-closed-label ${displayedClosedStatus.cls}${
                  pillAwaitingExpand
                    ? " is-awaiting-island"
                    : pillTextAnimSeq > 0
                      ? " nova-pill-blur-glide"
                      : ""
                }`}
              >
                {displayedClosedStatus.text}
              </span>
              <span className={`nova-pill-waveform state-${orbState}`} aria-hidden="true">
                <i />
                <i />
                <i />
                <i />
              </span>
            </div>
          </div>
        </div>

        {/* LAYER B: EXPANDED DYNAMIC ISLAND */}
        <div
          ref={expandedLayerRef}
          className={`nova-expanded-layer anchor-${effectiveZone}`}
          aria-hidden={!embeddedPreview}
        >
          <div ref={expandedMeasureRef} className="nova-expanded-inner">
            {/* SINGLE MERGED HEADER BAR: [Orb + NOVA] + [Tabs] on left, [Hub + Close] on right */}
            <div ref={topbarRef} className="nova-island-topbar">
              <div className="nova-brand-cluster">
                <NovaOrb
                  mode={settings.avatarMode}
                  aura={settings.aura}
                  state={orbState}
                  size={28}
                  activeCount={activeAgentCount}
                  activeRef={expOrbActiveRef}
                  wakeRef={expOrbWakeRef}
                  morphingRef={isMorphingRef}
                />
                <div className="nova-brand-titles">
                  <span className="nova-logo-text">NOVA</span>
                  <span className="nova-sub-badge">
                    {pendingQuestions.length > 0
                      ? `${pendingQuestions.length} ${t(lang, "waitingQuestion")}`
                      : pendingApprovals.length > 0
                        ? `${pendingApprovals.length} ${t(lang, "waitingApproval")}`
                        : `${activeAgentCount} ${t(lang, "activeAgents")}`}
                  </span>
                </div>
              </div>

              <div className="nova-island-nav">
                <button
                  className={`nova-nav-pill ${activeTab === "mission" ? "active" : ""}`}
                  onClick={() => setActiveTab("mission")}
                >
                  <Layers size={13} />
                  <span>{t(lang, "missionControl")}</span>
                  {(totalUrgentCount > 0 || cliSessions.length > 0) && (
                    <span className={`pill-counter ${totalUrgentCount > 0 ? "urgent" : ""}`}>
                      {totalUrgentCount > 0 ? `!${totalUrgentCount}` : cliSessions.length}
                    </span>
                  )}
                </button>

                <button
                  className={`nova-nav-pill ${activeTab === "chat" ? "active" : ""}`}
                  onClick={() => setActiveTab("chat")}
                >
                  <MessageSquare size={13} />
                  <span>{t(lang, "quickChat")}</span>
                </button>

                <button
                  className={`nova-nav-pill ${activeTab === "voice" ? "active" : ""}`}
                  onClick={() => setActiveTab("voice")}
                >
                  <Mic size={13} />
                  <span>{t(lang, "voiceSuite")}</span>
                </button>

                <button
                  className={`nova-nav-pill ${activeTab === "devtools" ? "active" : ""}`}
                  onClick={() => {
                    setActiveTab("devtools");
                    onRefreshSystem();
                  }}
                >
                  <Zap size={13} />
                  <span>{t(lang, "devTools")}</span>
                  {ports.length > 0 && <span className="pill-counter">{ports.length}</span>}
                </button>
              </div>

              <div className="nova-header-controls">
                {!embeddedPreview && (
                  <button
                    className="nova-icon-btn"
                    title={t(lang, "openHub")}
                    onClick={() => novaApi.openHubWindow()}
                  >
                    <Settings size={14} />
                  </button>
                )}

                <button
                  className="nova-icon-btn"
                  title={t(lang, "foldIsland")}
                  onClick={(e) => {
                    e.stopPropagation();
                    closeIsland({ force: true });
                  }}
                >
                  <X size={15} />
                </button>
              </div>
            </div>

            {/* BODY CONTENT */}
            <div
              ref={islandBodyRef}
              key={activeTab}
              className={`nova-island-body ${tabAnimated ? "nova-tab-stage" : ""}`}
            >
              {/* TAB 1: MISSION CONTROL */}
              {activeTab === "mission" && (
                <div className="nova-mission-layout">
                  {pendingQuestions.length > 0 && (
                    <div className="nova-questions-stack">
                      {pendingQuestions.map((pq) => (
                        <QuestionCard
                          key={pq.id}
                          pending={pq}
                          lang={lang}
                          sttProvider={settings.sttProvider}
                          hasCloudSttKey={hasCloudSttKey}
                          compact
                        />
                      ))}
                    </div>
                  )}

                  {pendingApprovals.length > 0 && (
                    <div className="nova-approvals-stack">
                      {pendingApprovals.map((app) => (
                        <ApprovalCard key={app.id} approval={app} lang={lang} />
                      ))}
                    </div>
                  )}

                  {!activeWorkspacePath ? (
                    <ProjectSelectHero snapshot={snapshot} lang={lang} aura={settings.aura} compact onSelectWorkspace={selectWorkspaceForMission} />
                  ) : (
                    <div className="nova-mission-full">
                      <div className="nova-project-topbar nova-unified-topbar">
                        <div className="nova-project-switcher-wrap" ref={projectSwitcherRef}>
                          <div className="nova-project-switcher">
                            <button
                              type="button"
                              className="nova-project-switcher-select"
                              aria-haspopup="menu"
                              aria-expanded={projectMenuOpen}
                              onClick={() => setProjectMenuOpen((open) => !open)}
                              title={activeWorkspacePath}
                            >
                              <FolderGit2 size={12} />
                              <span>{snapshot.recentWorkspaces?.find((workspace) => workspace.path.toLowerCase() === activeWorkspacePath.toLowerCase())?.name
                                || sessions.find((session) => session.workspacePath.toLowerCase() === activeWorkspacePath.toLowerCase())?.workspaceName
                                || activeWorkspacePath.split(/[\\/]/).filter(Boolean).pop()
                                || activeWorkspacePath}</span>
                              <ChevronDown size={12} />
                            </button>
                            <button
                              type="button"
                              className="nova-project-switcher-close"
                              aria-label={lang === "th" ? "ปิดแท็บโปรเจกต์" : "Close project tab"}
                              title={lang === "th" ? "ปิดแท็บโปรเจกต์" : "Close project tab"}
                              onClick={() => closeProjectTab(activeWorkspacePath)}
                            >
                              <X size={11} />
                            </button>
                          </div>
                          {projectMenuOpen && createPortal(
                            <div
                              ref={projectMenuRef}
                              className="nova-project-menu is-portaled"
                              data-nova-island-hover-region={projectMenuPosition ? "true" : undefined}
                              style={{
                                top: `${projectMenuPosition?.top ?? -10000}px`,
                                left: `${projectMenuPosition?.left ?? 8}px`,
                                maxHeight: projectMenuPosition ? `${projectMenuPosition.maxHeight}px` : undefined,
                                visibility: projectMenuPosition ? "visible" : "hidden",
                              }}
                              role="menu"
                              aria-label={lang === "th" ? "เลือกโปรเจกต์" : "Choose project"}
                            >
                              {projectPaths.map((path) => {
                                const label = snapshot.recentWorkspaces?.find((workspace) => workspace.path.toLowerCase() === path.toLowerCase())?.name
                                  || sessions.find((session) => session.workspacePath.toLowerCase() === path.toLowerCase())?.workspaceName
                                  || path.split(/[\\/]/).filter(Boolean).pop()
                                  || path;
                                const selected = activeWorkspacePath.toLowerCase() === path.toLowerCase();
                                return (
                                  <div key={path} className={`nova-project-menu-row ${selected ? "selected" : ""}`}>
                                    <button type="button" role="menuitemradio" aria-checked={selected} className="nova-project-menu-select" title={path} onClick={(e) => { notifyIslandPopoverSelect(e); selectWorkspaceForMission(path); }}>
                                      <FolderGit2 size={13} />
                                      <span>{label}</span>
                                      {selected && <CheckSquare size={12} />}
                                    </button>
                                    <button type="button" className="nova-project-menu-close" aria-label={`Close ${label} project tab`} title="Close project tab" onClick={(e) => { notifyIslandPopoverSelect(e); closeProjectTab(path); }}>
                                      <X size={11} />
                                    </button>
                                  </div>
                                );
                              })}
                              <div className="nova-project-menu-separator" />
                              <button type="button" className="nova-project-menu-add" role="menuitem" onClick={(e) => { notifyIslandPopoverSelect(e); void addProjectFromFolder(); }}>
                                <Plus size={13} /> {lang === "th" ? "เพิ่มโฟลเดอร์โปรเจกต์" : "Add project folder"}
                              </button>
                            </div>,
                            document.body
                          )}
                        </div>
                        <span className="nova-unified-divider" aria-hidden="true" />
                        <div className="nova-chat-tabs nova-unified-chat-tabs" aria-label={lang === "th" ? "แชตในโปรเจกต์" : "Chats in project"}>
                        {workspaceSessions.map((session, index) => (
                          <div key={session.conversationId} className={`nova-chat-tab ${selectedSession?.conversationId === session.conversationId ? "selected" : ""}`} title={session.lastUserInput || session.workspacePath}>
                            <button type="button" className="nova-chat-tab-main" onClick={() => { setSelectedSessionId(session.conversationId); setIsNewChatDraft(false); }}>
                              <span className={`ws-status-dot status-${session.status}`} />
                              <span>{session.lastUserInput?.trim().slice(0, 24) || `Chat ${index + 1}`}</span>
                            </button>
                            <button type="button" className="nova-tab-close" aria-label="Close chat tab" title="Close chat tab" onClick={() => closeChatTab(session.conversationId)}>
                              <X size={10} />
                            </button>
                          </div>
                        ))}
                        {isNewChatDraft && (
                          <div className="nova-chat-tab selected">
                            <button type="button" className="nova-chat-tab-main" onClick={() => setIsNewChatDraft(true)}><span>New chat</span></button>
                            <button type="button" className="nova-tab-close" aria-label="Close new chat tab" title="Close chat tab" onClick={() => { setIsNewChatDraft(false); setSelectedSessionId(null); }}>
                              <X size={10} />
                            </button>
                          </div>
                        )}
                        <button type="button" className="nova-chat-add nova-chat-add-icon" aria-label={lang === "th" ? "แชตใหม่" : "New chat"} title={lang === "th" ? "แชตใหม่" : "New chat"} onClick={() => { setSelectedSessionId(null); setIsNewChatDraft(true); }}>
                          <Plus size={14} />
                        </button>
                        </div>
                        <button
                          type="button"
                          className="nova-open-ide-pill"
                          title={selectedSession?.workspacePath || activeWorkspacePath}
                          onClick={() =>
                            void novaApi.openInEditor(
                              selectedSession?.workspacePath || activeWorkspacePath,
                              undefined,
                              "antigravity"
                            )
                          }
                        >
                          <ExternalLink size={11} />
                          <span>{lang === "th" ? "เปิด IDE" : "Open IDE"}</span>
                        </button>
                      </div>

                      {selectedSession ? (
                        <>
                          <div className="nova-session-detail nova-session-transcript-panel">
                            <SessionTelemetryView
                              session={selectedSession}
                              lang={lang}
                              compact
                            />
                          </div>
                          <div className="nova-session-composer-dock">
                            <SessionCockpit snapshot={snapshot} session={selectedSession} lang={lang} compact />
                          </div>
                        </>
                      ) : isNewChatDraft ? (
                        <div className="nova-session-composer-dock nova-session-composer-dock-empty">
                          <NewRunBar
                            snapshot={snapshot}
                            lang={lang}
                            workspacePath={activeWorkspacePath}
                            onStarted={() => {
                              keepOpenAfterSendUntilRef.current = Date.now() + 1200;
                              setIsNewChatDraft(false);
                            }}
                          />
                        </div>
                      ) : (
                        <div className="nova-session-detail nova-new-chat-detail">
                          <div className="nova-new-chat-empty">
                            <FolderGit2 size={18} />
                            <span>{lang === "th" ? "ไม่ได้เปิดบทสนทนา" : "No chat tab open"}</span>
                            <button type="button" className="nova-btn nova-btn-ghost nova-btn-xs" onClick={() => setIsNewChatDraft(true)}>
                              <Plus size={12} /> {lang === "th" ? "แชตใหม่" : "New chat"}
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}

              {/* TAB 2: AI CHAT & CONTEXT SUPERPOWERS */}
              {activeTab === "chat" && (
                <div className="nova-chat-layout">
                  <div className="nova-chat-toolbar">
                    <div className="nova-row-gap">
                      {chatWorkspacePath && (
                        <button type="button" className="nova-btn nova-btn-ghost nova-btn-xs chat-workspace-pill" title={chatWorkspacePath} onClick={() => setActiveTab("mission")}>
                          <FolderGit2 size={12} /> <span>{chatWorkspacePath.split(/[\\/]/).filter(Boolean).pop() || chatWorkspacePath}</span>
                        </button>
                      )}
                      <select
                        className="nova-select"
                        value={settings.defaultChatProvider}
                        onChange={(e) =>
                          novaApi.saveSettings({
                            ...settings,
                            defaultChatProvider: e.target.value,
                          })
                        }
                      >
                        <option value="gemini">Gemini API</option>
                        <option value="anthropic">Anthropic Claude</option>
                        <option value="openai">OpenAI</option>
                        <option value="groq">Groq (Ultra-Fast)</option>
                        <option value="openrouter">OpenRouter</option>
                        <option value="ollama">Ollama (Local)</option>
                        <option value="lmstudio">LM Studio (Local)</option>
                        <option value="cli-gemini">CLI Subscription (Gemini)</option>
                        <option value="cli-claude">CLI Subscription (Claude)</option>
                      </select>

                      <select
                        className="nova-select nova-model-select"
                        value={settings.defaultChatModel}
                        onChange={(e) => handleSelectModel(e.target.value)}
                        title="Chat AI Model"
                      >
                        {AVAILABLE_MODELS.map((m) => (
                          <option key={m.id} value={m.id}>
                            {m.name}
                          </option>
                        ))}
                      </select>

                      <button
                        type="button"
                        className={`nova-account-pill-mini ${activeAccount === "second" ? "is-second" : "is-main"}`}
                        onClick={() => handleToggleAccount()}
                        title={`Switch Active Account (Active: ${activeAccountName})`}
                      >
                        <User size={11} />
                        <span>{activeAccount === "second" ? "2nd" : "Main"}</span>
                      </button>

                      <button
                        type="button"
                        className={`nova-quota-pill-mini status-${quotaStatus}`}
                        onClick={() => void handleRefreshQuota()}
                        title={`Quota: ${activeQuota ? `${activeQuota.rpmUsed}/${activeQuota.rpmLimit} RPM` : "Ready"} (Click to refresh)`}
                      >
                        <Gauge size={11} />
                        <span>{activeQuota ? `${activeQuota.rpmUsed}/${activeQuota.rpmLimit}` : "Quota"}</span>
                      </button>

                      <input
                        ref={chatFileInputRef}
                        type="file"
                        accept="image/png,image/jpeg,image/webp,image/gif,image/bmp,image/*"
                        hidden
                        onChange={async (e) => {
                          const file = e.target.files?.[0];
                          e.target.value = "";
                          if (file) {
                            const durl = await fileToDataUrl(file);
                            if (durl) setSnipPreview(durl);
                          }
                        }}
                      />

                      <button
                        className="nova-btn nova-btn-ghost nova-btn-xs"
                        onClick={() => chatFileInputRef.current?.click()}
                        title={lang === "th" ? "อัปโหลดรูปภาพ (หรือ Ctrl+V วางรูป)" : "Upload Image (or Ctrl+V paste)"}
                      >
                        <ImagePlus size={13} />
                        <span>{lang === "th" ? "อัปโหลดรูป" : "Image"}</span>
                      </button>

                      <button
                        className="nova-btn nova-btn-ghost nova-btn-xs"
                        onClick={handleScreenSnip}
                        title="Capture Primary Display for Vision Analysis"
                      >
                        <Camera size={13} />
                        <span>{t(lang, "screenSnip")}</span>
                      </button>

                      <button
                        className={`nova-btn nova-btn-ghost nova-btn-xs ${
                          showClipboardDrawer ? "active-btn" : ""
                        }`}
                        onClick={() => setShowClipboardDrawer(!showClipboardDrawer)}
                      >
                        <Clipboard size={13} />
                        <span>
                          {t(lang, "clipboardHistory")} ({snapshot.clipboardHistory.length})
                        </span>
                      </button>
                    </div>

                    <button
                      className="nova-btn nova-btn-ghost nova-btn-xs"
                      onClick={() => void createChatThread()}
                    >
                      <Plus size={13} />
                      <span>New</span>
                    </button>
                  </div>

                  {showClipboardDrawer && (
                    <div className="nova-clipboard-drawer">
                      {snapshot.clipboardHistory.length === 0 ? (
                        <span className="muted-note">
                          Copy any text/code to populate Smart Clipboard.
                        </span>
                      ) : (
                        snapshot.clipboardHistory.slice(0, 6).map((cb) => (
                          <div key={cb.id} className="cb-item">
                            <span className="cb-kind">{cb.kind}</span>
                            <span
                              className="cb-preview"
                              onClick={() => {
                                setChatInput((prev) => `${prev}\n${cb.content}`.trim());
                                setShowClipboardDrawer(false);
                              }}
                            >
                              {cb.preview}
                            </span>
                            <button
                              className="nova-btn-ghost nova-btn-xs"
                              onClick={() => novaApi.copyToClipboard(cb.content)}
                            >
                              Copy
                            </button>
                          </div>
                        ))
                      )}
                    </div>
                  )}

                  <div className="nova-chat-messages">
                    {activeThread?.messages.map((m) => (
                      <div key={m.id} className={`chat-bubble role-${m.role}`}>
                        {m.imageDataUrl && (
                          <img
                            src={m.imageDataUrl}
                            alt="Screen snip"
                            className="chat-snip-thumb"
                          />
                        )}
                        {m.role === "assistant" ? (
                          <div className="chat-md-body">{renderMarkdownBlocks(m.content)}</div>
                        ) : (
                          <div className="chat-text">{m.content}</div>
                        )}
                      </div>
                    ))}
                    {chatSending && (
                      <div className="chat-bubble role-assistant muted-note">
                        NOVA thinking...
                      </div>
                    )}
                  </div>

                  {(snipPreview || droppedFilePath) && (
                    <div className="nova-attachment-bar">
                      {snipPreview && (
                        <div className="cockpit-thumb-card">
                          <img src={snipPreview} alt="Attached image" className="cockpit-thumb-img" />
                          <span className="cockpit-thumb-name">
                            {lang === "th" ? "แนบรูปภาพแล้ว" : "Image attached"}
                          </span>
                          <button
                            type="button"
                            className="cockpit-thumb-remove"
                            onClick={() => setSnipPreview(null)}
                          >
                            <X size={11} />
                          </button>
                        </div>
                      )}
                      {droppedFilePath && (
                        <span className="att-pill">
                          📎 {droppedFilePath}{" "}
                          <X size={12} onClick={() => setDroppedFilePath(null)} />
                        </span>
                      )}
                    </div>
                  )}

                  <div className="nova-chat-Compose">
                    <input
                      className="nova-input"
                      value={chatInput}
                      onChange={(e) => setChatInput(e.target.value)}
                      onPaste={async (e) => {
                        const item = Array.from(e.clipboardData?.items ?? []).find(
                          (it) => it.kind === "file" && it.type.startsWith("image/")
                        );
                        const file = item?.getAsFile() ?? e.clipboardData?.files?.[0];
                        if (file && isSupportedImageFile(file)) {
                          e.preventDefault();
                          const durl = await fileToDataUrl(file);
                          if (durl) setSnipPreview(durl);
                          return;
                        }
                        if (!e.clipboardData?.getData("text/plain")) {
                          e.preventDefault();
                          const cb = await novaApi.readClipboardImage();
                          if (cb.ok && cb.dataUrl) setSnipPreview(cb.dataUrl);
                        }
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && !e.shiftKey) {
                          e.preventDefault();
                          handleSendChat();
                        }
                      }}
                      placeholder="Ask NOVA in English or ภาษาไทย (Ctrl+V paste or drop image)..."
                    />
                    <button
                      className="nova-btn nova-btn-primary"
                      onClick={handleSendChat}
                      disabled={chatSending}
                    >
                      <Send size={14} />
                    </button>
                  </div>
                </div>
              )}

              {/* TAB 3: BILINGUAL VOICE & NOTES */}
              {activeTab === "voice" && (
                <VoiceRecorderPanel
                  snapshot={snapshot}
                  lang={lang}
                  compact
                  onVoiceCommand={(cmd) => {
                    setActiveTab("chat");
                    setChatInput(cmd);
                  }}
                />
              )}

              {/* TAB 4: BUILT-IN DEV & FOCUS UTILITIES */}
              {activeTab === "devtools" && (
                <div className="nova-devtools-layout">
                  <div className="nova-segmented">
                    <button
                      className={devSubTab === "ports" ? "active" : ""}
                      onClick={() => setDevSubTab("ports")}
                    >
                      <Globe size={12} /> Ports ({ports.length})
                    </button>
                    <button
                      className={devSubTab === "hardware" ? "active" : ""}
                      onClick={() => setDevSubTab("hardware")}
                    >
                      <Cpu size={12} /> Hardware
                    </button>
                    <button
                      className={devSubTab === "focus" ? "active" : ""}
                      onClick={() => setDevSubTab("focus")}
                    >
                      <CheckSquare size={12} /> Novadoro ({formatTimer(focus.remainingSec)})
                    </button>
                    <button
                      className={devSubTab === "media" ? "active" : ""}
                      onClick={() => setDevSubTab("media")}
                    >
                      <Music size={12} /> Media
                    </button>
                    <button
                      className={devSubTab === "github" ? "active" : ""}
                      onClick={() => setDevSubTab("github")}
                    >
                      <Github size={12} /> GitHub
                    </button>
                  </div>

                  {devSubTab === "ports" && (
                    <div className="nova-ports-list">
                      {ports.slice(0, 8).map((p) => (
                        <div key={p.port} className="port-row">
                          <div className="nova-row-gap">
                            <span className="port-badge">:{p.port}</span>
                            <span className="port-proc">{p.processName}</span>
                            {p.frameworkHint && (
                              <span className="port-hint">{p.frameworkHint}</span>
                            )}
                          </div>
                          <div className="nova-btn-group">
                            <button
                              className="nova-btn nova-btn-ghost nova-btn-xs"
                              onClick={() =>
                                novaApi.openExternalUrl(`http://localhost:${p.port}`)
                              }
                            >
                              <ExternalLink size={12} /> Open
                            </button>
                            {p.port !== 47920 && (
                              <button
                                className="nova-btn nova-btn-deny nova-btn-xs"
                                onClick={async () => {
                                  await novaApi.killPortPid(p.pid);
                                  onRefreshSystem();
                                }}
                              >
                                <Trash2 size={12} /> Kill
                              </button>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}

                  {devSubTab === "hardware" && telemetry && (
                    <div className="nova-hw-panel">
                      <div className="hw-meters-grid">
                        <div className="hw-card">
                          <span className="hw-label">CPU ({telemetry.coreCount} cores)</span>
                          <strong className="hw-val">{telemetry.cpuPercent.toFixed(1)}%</strong>
                          <div className="hw-bar">
                            <div style={{ width: `${Math.min(100, telemetry.cpuPercent)}%` }} />
                          </div>
                        </div>
                        <div className="hw-card">
                          <span className="hw-label">RAM</span>
                          <strong className="hw-val">
                            {telemetry.ramUsedGb.toFixed(1)} / {telemetry.ramTotalGb.toFixed(1)}{" "}
                            GB
                          </strong>
                          <div className="hw-bar">
                            <div style={{ width: `${Math.min(100, telemetry.ramPercent)}%` }} />
                          </div>
                        </div>
                        {telemetry.gpu && (
                          <div className="hw-card">
                            <span className="hw-label">{telemetry.gpu.name}</span>
                            <strong className="hw-val">
                              {telemetry.gpu.loadPercent.toFixed(0)}% ·{" "}
                              {telemetry.gpu.vramUsedMb} MB
                              {telemetry.gpu.tempC ? ` · ${telemetry.gpu.tempC}°C` : ""}
                            </strong>
                            <div className="hw-bar">
                              <div
                                style={{
                                  width: `${Math.min(100, telemetry.gpu.loadPercent)}%`,
                                }}
                              />
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                  )}

                  {devSubTab === "focus" && (
                    <div className="nova-focus-mini">
                      <div className="nova-row-between">
                        <div>
                          <span className="timer-digits">{formatTimer(focus.remainingSec)}</span>
                          <span className="muted-note"> · {focus.currentGoal}</span>
                        </div>
                        <div className="nova-btn-group">
                          <button
                            className="nova-btn nova-btn-primary nova-btn-xs"
                            onClick={() =>
                              novaApi.controlFocusTimer(focus.running ? "pause" : "start")
                            }
                          >
                            {focus.running ? <Pause size={13} /> : <Play size={13} />}
                            <span>{focus.running ? "Pause" : "Start"}</span>
                          </button>
                          <button
                            className="nova-btn nova-btn-ghost nova-btn-xs"
                            onClick={() => novaApi.controlFocusTimer("reset")}
                          >
                            <RotateCcw size={13} />
                          </button>
                        </div>
                      </div>

                      <div className="todo-mini-list">
                        {focus.todos.slice(0, 4).map((td) => (
                          <label key={td.id} className="todo-row">
                            <input
                              type="checkbox"
                              checked={td.completed}
                              onChange={() => {
                                const updated = focus.todos.map((x) =>
                                  x.id === td.id ? { ...x, completed: !x.completed } : x
                                );
                                novaApi.saveTodos(updated);
                              }}
                            />
                            <span className={td.completed ? "todo-done" : ""}>{td.text}</span>
                          </label>
                        ))}
                        <div className="nova-row-gap">
                          <input
                            className="nova-input nova-input-xs"
                            placeholder="Add quick focus todo..."
                            value={newTodoText}
                            onChange={(e) => setNewTodoText(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter" && newTodoText.trim()) {
                                novaApi.saveTodos([
                                  ...focus.todos,
                                  {
                                    id: `td-${Date.now()}`,
                                    text: newTodoText.trim(),
                                    completed: false,
                                    createdAt: new Date().toISOString(),
                                  },
                                ]);
                                setNewTodoText("");
                              }
                            }}
                          />
                        </div>
                      </div>
                    </div>
                  )}

                  {devSubTab === "media" && (
                    <div className="nova-media-card">
                      {media?.active ? (
                        <div className="nova-row-between">
                          <div>
                            <div className="media-title">{media.title}</div>
                            <div className="muted-note">{media.artist || media.sourceApp}</div>
                          </div>
                          <div className="nova-btn-group">
                            <button
                              className="nova-btn nova-btn-ghost nova-btn-xs"
                              onClick={async () => {
                                await novaApi.controlMedia("prev");
                                onRefreshSystem();
                              }}
                            >
                              ⏮
                            </button>
                            <button
                              className="nova-btn nova-btn-primary nova-btn-xs"
                              onClick={async () => {
                                await novaApi.controlMedia("toggle");
                                onRefreshSystem();
                              }}
                            >
                              {media.playing ? <Pause size={13} /> : <Play size={13} />}
                            </button>
                            <button
                              className="nova-btn nova-btn-ghost nova-btn-xs"
                              onClick={async () => {
                                await novaApi.controlMedia("next");
                                onRefreshSystem();
                              }}
                            >
                              <SkipForward size={13} />
                            </button>
                          </div>
                        </div>
                      ) : (
                        <div className="muted-note">
                          No active Windows media session detected (play Spotify, YouTube Music,
                          or browser audio).
                        </div>
                      )}
                    </div>
                  )}

                  {devSubTab === "github" && (
                    <div className="nova-github-mini">
                      {!github?.connected ? (
                        <div className="muted-note">
                          Add a GitHub Personal Access Token in <strong>Settings → AI & Keys</strong>{" "}
                          to track PRs, Reviews & Actions CI.
                        </div>
                      ) : (
                        <div className="gh-lists">
                          <div className="gh-summary-bar">
                            <span>@{github.username}</span>
                            <span>Open PRs: {github.myPrs.length}</span>
                            <span>To Review: {github.reviewRequests.length}</span>
                          </div>
                          {github.myPrs.slice(0, 3).map((pr) => (
                            <div
                              key={pr.url}
                              className="port-row clickable"
                              onClick={() => novaApi.openExternalUrl(pr.url)}
                            >
                              <span>
                                <strong>{pr.repo}</strong> #{pr.number} · {pr.title}
                              </span>
                              <ExternalLink size={12} />
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
