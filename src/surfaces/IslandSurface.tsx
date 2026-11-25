import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  Camera,
  Check,
  CheckSquare,
  ChevronDown,
  ChevronRight,
  Clipboard,
  Cpu,
  ExternalLink,
  FolderGit2,
  Gauge,
  GitBranch,
  Github,
  Globe,
  ImagePlus,
  Languages,
  Layers,
  MessageSquare,
  Mic,
  Music,
  Pause,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  Send,
  Settings,
  SkipForward,
  Sparkles,
  Terminal,
  Trash2,
  User,
  Volume2,
  VolumeX,
  X,
  Zap,
} from "lucide-react";
import {
  AVAILABLE_MODELS,
  GitHubOverview,
  HardwareTelemetry,
  MediaStatus,
  NovaSnapshot,
  PortProcessInfo,
} from "../types";
import { Lang, t } from "../i18n";
import { isTauriRuntime, novaApi } from "../lib/novaClient";
import { playNovaCue } from "../lib/soundEngine";
import {
  clamp,
  ISLAND_CLOSE_MS,
  ISLAND_OPEN_DAMPING,
  ISLAND_OPEN_RESPONSE,
  prefersReducedMotion,
  revealCurve,
  TrackedValue,
} from "../lib/islandSpring";
import { NovaOrb, OrbState } from "../components/NovaOrb";
import { ApprovalCard } from "../components/ApprovalCard";
import { DiffViewer } from "../components/DiffViewer";
import { getPhaseLabel, SessionTelemetryView } from "../components/SessionTelemetryView";
import {
  fileToDataUrl,
  isSupportedImageFile,
  NewRunBar,
  PermissionPill,
  SessionCockpit,
} from "../components/SessionCockpit";
import { VoiceRecorderPanel } from "../components/VoiceRecorderPanel";

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
const MIN_PILL_WIDTH = 148;
const MAX_EXPANDED_HEIGHT = 626;
const SHADOW_BASE_W = 880;
const SHADOW_BASE_H = 520;

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
  const lang: Lang = settings.language;

  const [activeTab, setActiveTab] = useState<"mission" | "chat" | "voice" | "devtools">("mission");
  const [cmdQuery, setCmdQuery] = useState("");
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [showNewRunDrawer, setShowNewRunDrawer] = useState(false);

  // Chat state
  const [chatInput, setChatInput] = useState("");
  const [chatSending, setChatSending] = useState(false);
  const [snipPreview, setSnipPreview] = useState<string | null>(null);
  const [droppedFilePath, setDroppedFilePath] = useState<string | null>(null);
  const [showClipboardDrawer, setShowClipboardDrawer] = useState(false);

  // Dev utilities sub-tab state
  const [devSubTab, setDevSubTab] = useState<"ports" | "hardware" | "focus" | "media" | "github">(
    "ports"
  );
  const [newTodoText, setNewTodoText] = useState("");

  // Real-time Quota, Account Switcher & Model Selector state
  const [showQuotaPopover, setShowQuotaPopover] = useState(false);
  const [showModelDropdown, setShowModelDropdown] = useState(false);
  const [quotaRefreshing, setQuotaRefreshing] = useState(false);
  const quotaPopoverRef = useRef<HTMLDivElement | null>(null);
  const modelDropdownRef = useRef<HTMLDivElement | null>(null);

  // DOM measurement & animation refs (zero React re-renders and zero DOM layout reads during expand/collapse)
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const shadowRef = useRef<HTMLDivElement | null>(null);
  const shellRef = useRef<HTMLDivElement | null>(null);
  const pillLayerRef = useRef<HTMLDivElement | null>(null);
  const pillMeasureRef = useRef<HTMLDivElement | null>(null);
  const expandedLayerRef = useRef<HTMLDivElement | null>(null);
  const expandedMeasureRef = useRef<HTMLDivElement | null>(null);
  const cmdInputRef = useRef<HTMLInputElement | null>(null);
  const chatFileInputRef = useRef<HTMLInputElement | null>(null);

  const pillOrbActiveRef = useRef<boolean>(!embeddedPreview);
  const pillOrbWakeRef = useRef<(() => void) | null>(null);
  const expOrbActiveRef = useRef<boolean>(embeddedPreview);
  const expOrbWakeRef = useRef<(() => void) | null>(null);

  const vpSizeRef = useRef<{ w: number; h: number }>({
    w: typeof window !== "undefined" ? window.innerWidth || 900 : 900,
    h: typeof window !== "undefined" ? window.innerHeight || 690 : 690,
  });
  const lastAppliedExpWRef = useRef<number>(0);
  const lastRectPushMsRef = useRef<number>(0);

  const foldTimerRef = useRef<number | null>(null);
  const refreshTimerRef = useRef<number | null>(null);

  const pillWidthRef = useRef<number>(168);
  const expandedHeightRef = useRef<number>(280);
  const expandedRef = useRef<boolean>(embeddedPreview);
  const pillHoveredRef = useRef<boolean>(false);
  const proximityRef = useRef<number>(0);
  const pointerInsideRef = useRef<boolean>(false);
  const soundEnabledRef = useRef<boolean>(settings.soundEnabled);
  const snapZoneRef = useRef<string>(settings.snapZone);
  const monitorIndexRef = useRef<number>(settings.monitorIndex);
  const pendingCountRef = useRef<number>(pendingApprovals.length);
  const suppressFullscreenRef = useRef<boolean>(
    Boolean(settings.suppressFullscreen && telemetry?.fullscreenActive)
  );

  soundEnabledRef.current = settings.soundEnabled;
  snapZoneRef.current = settings.snapZone;
  monitorIndexRef.current = settings.monitorIndex;
  pendingCountRef.current = pendingApprovals.length;
  suppressFullscreenRef.current = Boolean(
    settings.suppressFullscreen && telemetry?.fullscreenActive
  );

  // Physics tracks initialized to starting state
  const widthTrackRef = useRef<TrackedValue>(
    new TrackedValue(embeddedPreview ? EXPANDED_WIDTH : 168)
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

  const activeAgentCount = useMemo(
    () => sessions.filter((s) => s.status === "active" || s.status === "waiting_approval").length,
    [sessions]
  );

  const orbState: OrbState =
    pendingApprovals.length > 0
      ? "alert"
      : activeAgentCount > 0
      ? "active"
      : "idle";

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

  const pushHitRectIfNeeded = useCallback(
    (rx: number, ry: number, hitW: number, hitH: number, force = false) => {
      if (embeddedPreview) return;
      const now = performance.now();
      if (!force && now - lastRectPushMsRef.current < 48) return;
      const prev = pushedRectRef.current;
      if (
        force ||
        Math.abs(prev.x - rx) > 1 ||
        Math.abs(prev.y - ry) > 1 ||
        Math.abs(prev.w - hitW) > 1 ||
        Math.abs(prev.h - hitH) > 1
      ) {
        pushedRectRef.current = { x: rx, y: ry, w: hitW, h: hitH };
        lastRectPushMsRef.current = now;
        novaApi.setIslandRect(rx, ry, hitW, hitH);
      }
    },
    [embeddedPreview]
  );

  const applyFrameStyles = useCallback(
    (stillMoving = false) => {
      const shell = shellRef.current;
      const pillLayer = pillLayerRef.current;
      const expandedLayer = expandedLayerRef.current;
      if (!shell || !pillLayer || !expandedLayer) return;

      const w = widthTrackRef.current.value;
      const h = heightTrackRef.current.value;
      const r = radiusTrackRef.current.value;

      const basePillW = pillWidthRef.current;
      const targetExpW = getMaxExpandedWidth();
      const spanW = Math.max(1, targetExpW - basePillW);
      const p = clamp((w - basePillW) / spanW, 0, 1);
      const isOpening = expandedRef.current;
      const isBottom = snapZoneRef.current === "bottom-dock" && !embeddedPreview;
      const { rx: shellX, ry: shellY, zone } = computeZoneRect(w, h);

      shell.style.width = `${w.toFixed(2)}px`;
      shell.style.height = `${h.toFixed(2)}px`;
      shell.style.borderRadius = `${r.toFixed(2)}px`;
      if (!embeddedPreview) {
        shell.style.transform = `translate3d(${shellX.toFixed(2)}px, ${shellY.toFixed(2)}px, 0)`;
      }

      // GPU-scaled ambient shadow quad (never crosses Blink 2x raster boundary, 0ms paint cost)
      if (!embeddedPreview && shadowRef.current) {
        const sx = (w + 36) / SHADOW_BASE_W;
        const sy = (h + 36) / SHADOW_BASE_H;
        const shX = shellX - 18;
        const shY = shellY - 8;
        const shAlpha = 0.56 + 0.44 * p;
        shadowRef.current.style.opacity = shAlpha.toFixed(3);
        shadowRef.current.style.transform = `translate3d(${shX.toFixed(2)}px, ${shY.toFixed(
          2
        )}px, 0) scale3d(${sx.toFixed(4)}, ${sy.toFixed(4)}, 1)`;
      }

      // Layer A: Constant-box Compact Pill (pure GPU translate3d + scale3d + opacity, zero flex reflow)
      const pillFadeWindow = isOpening ? 0.26 : 0.48;
      const pillAlpha = clamp(1 - p / pillFadeWindow, 0, 1);
      if (pillAlpha <= 0.002) {
        pillLayer.style.opacity = "0";
        pillLayer.style.visibility = "hidden";
        pillLayer.style.pointerEvents = "none";
      } else {
        const pillScale = isOpening ? 1 + (1 - pillAlpha) * 0.05 : 0.945 + pillAlpha * 0.055;
        const pillX =
          zone === "top-left" ? 0 : zone === "top-right" ? w - basePillW : (w - basePillW) * 0.5;
        const pillInsetY = Math.min(10, Math.max(0, (h - PILL_HEIGHT) * 0.5));
        const pillY = isBottom ? h - PILL_HEIGHT - pillInsetY : pillInsetY;
        pillLayer.style.visibility = "visible";
        pillLayer.style.opacity = pillAlpha.toFixed(4);
        pillLayer.style.pointerEvents = !isOpening && p < 0.22 ? "auto" : "none";
        pillLayer.style.transform = `translate3d(${pillX.toFixed(2)}px, ${pillY.toFixed(
          2
        )}px, 0) scale3d(${pillScale.toFixed(4)}, ${pillScale.toFixed(4)}, 1)`;
      }

      // Layer B: Unified GPU-cached Expanded Surface (single composited texture, zero nested RenderSurfaces)
      if (lastAppliedExpWRef.current !== targetExpW) {
        lastAppliedExpWRef.current = targetExpW;
        expandedLayer.style.width = `${targetExpW}px`;
      }

      const rawExpAlpha = isOpening
        ? clamp((p - 0.07) / 0.72, 0, 1)
        : clamp((p - 0.28) / 0.64, 0, 1);
      const expAlpha = isOpening ? revealCurve(rawExpAlpha) : rawExpAlpha;

      if (expAlpha <= 0.002) {
        expandedLayer.style.opacity = "0";
        expandedLayer.style.visibility = "hidden";
        expandedLayer.style.pointerEvents = "none";
      } else {
        const expScale = isOpening ? 0.962 + 0.038 * expAlpha : 0.968 + 0.032 * expAlpha;
        const expShiftY = (1 - expAlpha) * (isBottom ? 6 : -6);
        const expX =
          zone === "top-left" ? 0 : zone === "top-right" ? w - targetExpW : (w - targetExpW) * 0.5;
        const expY = (isBottom ? h - expandedHeightRef.current : 0) + expShiftY;

        expandedLayer.style.visibility = "visible";
        expandedLayer.style.opacity = expAlpha.toFixed(4);
        expandedLayer.style.pointerEvents = isOpening && p > 0.52 ? "auto" : "none";
        expandedLayer.style.transform = `translate3d(${expX.toFixed(2)}px, ${expY.toFixed(
          2
        )}px, 0) scale3d(${expScale.toFixed(4)}, ${expScale.toFixed(4)}, 1)`;
      }

      // Sync Tauri hit-rect without per-frame IPC spam:
      // - When opening, target expanded hit-rect is already pushed once on openIsland/resize.
      // - When collapsing, throttle updates to ~20Hz and snap cleanly to resting pill at settle.
      if (!embeddedPreview) {
        if (isOpening) {
          if (!stillMoving) {
            const { rx: tRx, ry: tRy } = computeZoneRect(targetExpW, expandedHeightRef.current);
            pushHitRectIfNeeded(tRx, tRy, targetExpW, expandedHeightRef.current, true);
          }
        } else {
          const hitW = p < 0.08 ? basePillW : w;
          const hitH = p < 0.08 ? PILL_HEIGHT : h;
          const { rx: hRx, ry: hRy } = computeZoneRect(hitW, hitH);
          pushHitRectIfNeeded(hRx, hRy, hitW, hitH, !stillMoving);
        }
      }
    },
    [computeZoneRect, embeddedPreview, getMaxExpandedWidth, pushHitRectIfNeeded]
  );

  const ensurePhysicsLoop = useCallback(() => {
    if (rafIdRef.current) return;
    lastFrameMsRef.current = performance.now();
    shellRef.current?.classList.add("is-morphing");

    const stepFrame = (now: number) => {
      const dt = Math.min(0.05, Math.max(0.001, (now - lastFrameMsRef.current) / 1000));
      lastFrameMsRef.current = now;

      widthTrackRef.current.step(dt, now);
      heightTrackRef.current.step(dt, now);
      radiusTrackRef.current.step(dt, now);

      const stillMoving =
        widthTrackRef.current.animating ||
        heightTrackRef.current.animating ||
        radiusTrackRef.current.animating;

      applyFrameStyles(stillMoving);

      if (stillMoving) {
        rafIdRef.current = window.requestAnimationFrame(stepFrame);
      } else {
        rafIdRef.current = 0;
        shellRef.current?.classList.remove("is-morphing");
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
      const prox = !isExp && pillHoveredRef.current ? clamp(proximityRef.current, 0.2, 1) : 0;
      const hoverBoost = prox > 0 ? Math.round(12 * prox * 10) / 10 : 0;
      const hoverHeightBoost = prox > 0 ? Math.round(2.5 * prox * 10) / 10 : 0;

      const targetW = isExp ? getMaxExpandedWidth() : pillWidthRef.current + hoverBoost;
      const targetH = isExp ? expandedHeightRef.current : PILL_HEIGHT + hoverHeightBoost;
      const targetR = isExp ? EXPANDED_RADIUS : (PILL_HEIGHT + hoverHeightBoost) * 0.5;

      if (reduced) {
        widthTrackRef.current.jump(targetW);
        heightTrackRef.current.jump(targetH);
        radiusTrackRef.current.jump(targetR);
        applyFrameStyles();
        return;
      }

      const now = performance.now();
      if (isExp) {
        widthTrackRef.current.springTo(targetW, ISLAND_OPEN_RESPONSE, ISLAND_OPEN_DAMPING);
        heightTrackRef.current.morphTo(targetH, {
          response: ISLAND_OPEN_RESPONSE,
          damping: Math.min(0.92, ISLAND_OPEN_DAMPING + 0.05),
          durationMs: ISLAND_CLOSE_MS,
          nowMs: now,
        });
        radiusTrackRef.current.springTo(targetR, ISLAND_OPEN_RESPONSE * 0.9, 0.86);
      } else if (
        pillHoveredRef.current &&
        widthTrackRef.current.value <= pillWidthRef.current + 18
      ) {
        widthTrackRef.current.springTo(targetW, 0.22, 0.80);
        heightTrackRef.current.springTo(targetH, 0.22, 0.84);
        radiusTrackRef.current.springTo(targetR, 0.22, 0.86);
      } else {
        widthTrackRef.current.curveTowards(targetW, ISLAND_CLOSE_MS, now);
        heightTrackRef.current.curveTowards(targetH, ISLAND_CLOSE_MS, now);
        radiusTrackRef.current.curveTowards(targetR, ISLAND_CLOSE_MS, now);
      }

      ensurePhysicsLoop();
    },
    [applyFrameStyles, ensurePhysicsLoop, getMaxExpandedWidth]
  );

  const openIsland = useCallback(
    (opts?: { focusCmd?: boolean; silent?: boolean }) => {
      if (foldTimerRef.current) {
        window.clearTimeout(foldTimerRef.current);
        foldTimerRef.current = null;
      }

      const alreadyOpen = expandedRef.current;
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

      retargetGeometry();

      if (!alreadyOpen) {
        if (!opts?.silent) {
          window.setTimeout(() => playNovaCue("island_open", soundEnabledRef.current), 0);
        }
        // Defer background telemetry/port refresh until AFTER the spring settles so Frame 0 stays 100% stutter-free
        if (refreshTimerRef.current) window.clearTimeout(refreshTimerRef.current);
        refreshTimerRef.current = window.setTimeout(() => {
          refreshTimerRef.current = null;
          if (expandedRef.current) onRefreshSystem();
        }, 460);
      }

      if (opts?.focusCmd) {
        window.setTimeout(() => cmdInputRef.current?.focus(), 60);
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
      expandedRef.current = false;
      pillHoveredRef.current = false;
      proximityRef.current = 0;
      pillOrbActiveRef.current = true;
      pillOrbWakeRef.current?.();
      syncDomShellFlags();

      retargetGeometry();

      if (!embeddedPreview && wasOpen) {
        void novaApi.setIslandExpanded(false, snapZoneRef.current, monitorIndexRef.current);
      }

      if (wasOpen && !opts?.silent) {
        window.setTimeout(() => playNovaCue("island_close", soundEnabledRef.current), 0);
      }
    },
    [embeddedPreview, retargetGeometry, syncDomShellFlags]
  );

  const enterHover = useCallback(() => {
    pointerInsideRef.current = true;

    if (foldTimerRef.current) {
      window.clearTimeout(foldTimerRef.current);
      foldTimerRef.current = null;
    }

    // Re-entering mid-collapse immediately reverses into spring open!
    if (!expandedRef.current && widthTrackRef.current.animating && !pillHoveredRef.current) {
      openIsland({ silent: true });
      return;
    }

    if (expandedRef.current) return;
    if (suppressFullscreenRef.current && pendingCountRef.current === 0) {
      return;
    }
    openIsland({ silent: widthTrackRef.current.animating && !pillHoveredRef.current });
  }, [openIsland]);

  const leaveHover = useCallback(() => {
    if (!pointerInsideRef.current) return;
    pointerInsideRef.current = false;

    if (!expandedRef.current) {
      if (pillHoveredRef.current) {
        pillHoveredRef.current = false;
        proximityRef.current = 0;
        syncDomShellFlags();
        retargetGeometry();
      }
      return;
    }

    if (pendingCountRef.current > 0) return;
    if (foldTimerRef.current) window.clearTimeout(foldTimerRef.current);
    foldTimerRef.current = window.setTimeout(() => {
      foldTimerRef.current = null;
      closeIsland();
    }, 135);
  }, [closeIsland, retargetGeometry, syncDomShellFlags]);

  // Measure natural pill width & expanded content height continuously via ResizeObserver
  useLayoutEffect(() => {
    const pillEl = pillMeasureRef.current;
    const expEl = expandedMeasureRef.current;
    vpSizeRef.current = {
      w: window.innerWidth || 900,
      h: window.innerHeight || 690,
    };

    const syncPillWidth = () => {
      if (!pillEl) return;
      const measured = Math.max(MIN_PILL_WIDTH, Math.ceil(pillEl.offsetWidth));
      if (Math.abs(measured - pillWidthRef.current) >= 1) {
        const firstMeasure = pillWidthRef.current === 168 && !widthTrackRef.current.animating;
        pillWidthRef.current = measured;
        if (!expandedRef.current) {
          retargetGeometry({ immediate: firstMeasure });
        }
      }
    };

    const syncExpandedHeight = () => {
      if (!expEl) return;
      const rawH = Math.ceil(expEl.offsetHeight);
      const minH = cmdQuery.trim().length > 0 ? 310 : 180;
      const clampedH = clamp(rawH, minH, MAX_EXPANDED_HEIGHT);
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

    const ro = new ResizeObserver(() => {
      syncPillWidth();
      syncExpandedHeight();
    });
    if (pillEl) ro.observe(pillEl);
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
    cmdQuery,
    computeZoneRect,
    embeddedPreview,
    getMaxExpandedWidth,
    pushHitRectIfNeeded,
    retargetGeometry,
    syncDomShellFlags,
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

  // Auto-open whenever an urgent approval arrives
  useEffect(() => {
    if (pendingApprovals.length > 0) {
      setActiveTab("mission");
      openIsland({ silent: true });
    }
  }, [pendingApprovals.length, openIsland]);

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

  // Authoritative Win32 cursor hit-tester events in Tauri desktop mode
  useEffect(() => {
    if (embeddedPreview) return;
    let unlisten: (() => void) | undefined;
    novaApi
      .onIslandPointer(({ inside, proximity = 0 }) => {
        if (inside) {
          enterHover();
          return;
        }

        if (pointerInsideRef.current) {
          leaveHover();
        }

        // Magnetic pre-wake swell while approaching the folded capsule (`MAGNET_ZONE_PX`)
        if (!expandedRef.current && !(suppressFullscreenRef.current && pendingCountRef.current === 0)) {
          const nextProx = clamp(proximity, 0, 1);
          const nextNear = nextProx > 0.04;
          const prevNear = pillHoveredRef.current;
          const delta = Math.abs(nextProx - proximityRef.current);
          if (nextNear !== prevNear || (nextNear && delta >= 0.08)) {
            proximityRef.current = nextNear ? nextProx : 0;
            pillHoveredRef.current = nextNear;
            syncDomShellFlags();
            retargetGeometry();
          } else if (nextNear) {
            proximityRef.current = nextProx;
          }
        }
      })
      .then((fn) => {
        unlisten = fn;
      });

    return () => {
      unlisten?.();
    };
  }, [embeddedPreview, enterHover, leaveHover, retargetGeometry, syncDomShellFlags]);

  // Global keyboard shortcut inside window (`Ctrl+Alt+Space` / `Ctrl+K` / `Escape`)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && expandedRef.current) {
        if (cmdQuery) {
          setCmdQuery("");
          return;
        }
        closeIsland({ force: pendingApprovals.length === 0 });
      }
      if (
        (e.ctrlKey && e.altKey && e.code === "Space") ||
        (e.ctrlKey && e.key.toLowerCase() === "k")
      ) {
        e.preventDefault();
        openIsland({ focusCmd: true });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
    };
  }, [closeIsland, cmdQuery, openIsland, pendingApprovals.length]);

  const useNativePointerPoll = !embeddedPreview && isTauriRuntime();

  const handleShellPointerEnter = () => {
    enterHover();
  };

  const handleShellPointerLeave = () => {
    // In Tauri desktop overlay, Win32 GetCursorPos (`onIslandPointer`) handles leave so native
    // <select> popups or child transitions never trigger false mouseleave folds.
    if (useNativePointerPoll) return;
    leaveHover();
  };

  const selectedSession =
    sessions.find((s) => s.conversationId === selectedSessionId) || sessions[0] || null;

  const activeThread = snapshot.threads[0] || null;

  // Unified Command Palette fuzzy results
  const commandMatches = useMemo(() => {
    const q = cmdQuery.trim().toLowerCase();
    if (!q) return [];
    const results: Array<{ id: string; badge: string; label: string; run: () => void }> = [];

    for (const s of sessions) {
      if (
        s.workspaceName.toLowerCase().includes(q) ||
        (s.gitBranch ?? "").toLowerCase().includes(q)
      ) {
        results.push({
          id: `sess-${s.conversationId}`,
          badge: "WORKSPACE",
          label: `${s.workspaceName} (${s.gitBranch || "main"}) — Focus Window`,
          run: () => {
            novaApi.focusSessionWindow(s.conversationId);
            setCmdQuery("");
          },
        });
      }
    }

    for (const p of ports) {
      if (
        String(p.port).includes(q) ||
        p.processName.toLowerCase().includes(q) ||
        (p.frameworkHint ?? "").toLowerCase().includes(q)
      ) {
        results.push({
          id: `port-${p.port}`,
          badge: `PORT :${p.port}`,
          label: `Open http://localhost:${p.port} (${p.processName})`,
          run: () => {
            novaApi.openExternalUrl(`http://localhost:${p.port}`);
            setCmdQuery("");
          },
        });
      }
    }

    for (const cb of snapshot.clipboardHistory) {
      if (cb.content.toLowerCase().includes(q)) {
        results.push({
          id: `cb-${cb.id}`,
          badge: "CLIPBOARD",
          label: `Copy: ${cb.preview}`,
          run: () => {
            novaApi.copyToClipboard(cb.content);
            setCmdQuery("");
          },
        });
      }
    }

    results.push({
      id: "ask-ai-direct",
      badge: "ASK NOVA AI",
      label: `Send "${cmdQuery}" to NOVA Quick Chat`,
      run: () => {
        setActiveTab("chat");
        setChatInput(cmdQuery);
        setCmdQuery("");
      },
    });

    return results.slice(0, 6);
  }, [cmdQuery, sessions, ports, snapshot.clipboardHistory]);

  const handleSendChat = async () => {
    if (!chatInput.trim() && !snipPreview) return;
    const threadId = activeThread?.id ?? "thread-main";
    const text = chatInput.trim() || "Analyze this captured screen context.";
    setChatInput("");
    setChatSending(true);
    await novaApi.sendChat({
      threadId,
      content: text,
      provider: settings.defaultChatProvider,
      model: settings.defaultChatModel,
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

  // Account, Quota & Model logic
  const activeAccount = settings.activeAccount === "second" ? "second" : "main";
  const mainName = settings.mainAccountName || "Main Account";
  const secondName = settings.secondAccountName || "Second Account";
  const activeAccountName = activeAccount === "second" ? secondName : mainName;

  const quota = snapshot.quota;
  const mainQuota = quota?.main;
  const secondQuota = quota?.second;
  const activeQuota = activeAccount === "second" ? secondQuota : mainQuota;
  const quotaStatus = activeQuota?.status || "healthy";

  const currentModelId = settings.defaultChatModel || "gemini-3.8-flash-high";
  const currentModel = AVAILABLE_MODELS.find((m) => m.id === currentModelId) || {
    id: currentModelId,
    name: currentModelId,
    provider: settings.defaultChatProvider || "gemini",
    badge: currentModelId.replace("gemini-", "").replace("claude-", ""),
  };

  const handleToggleAccount = async (targetAccount?: "main" | "second") => {
    const next = targetAccount ?? (activeAccount === "main" ? "second" : "main");
    playNovaCue("step", settings.soundEnabled);
    await novaApi.switchAccount(next);
  };

  const handleRefreshQuota = async () => {
    setQuotaRefreshing(true);
    try {
      await novaApi.refreshQuota();
      playNovaCue("ready", settings.soundEnabled);
    } finally {
      setQuotaRefreshing(false);
    }
  };

  const handleSelectModel = async (modelId: string) => {
    const found = AVAILABLE_MODELS.find((m) => m.id === modelId);
    const newProvider = found ? found.provider : settings.defaultChatProvider;
    await novaApi.saveSettings({
      ...settings,
      defaultChatModel: modelId,
      defaultChatProvider: newProvider,
    });
    setShowModelDropdown(false);
    playNovaCue("step", settings.soundEnabled);
  };

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (
        quotaPopoverRef.current &&
        !quotaPopoverRef.current.contains(target as Node) &&
        !target?.closest(".nova-quota-trigger")
      ) {
        setShowQuotaPopover(false);
      }
      if (
        modelDropdownRef.current &&
        !modelDropdownRef.current.contains(target as Node) &&
        !target?.closest(".nova-model-trigger")
      ) {
        setShowModelDropdown(false);
      }
    };
    window.addEventListener("mousedown", handleClickOutside);
    return () => window.removeEventListener("mousedown", handleClickOutside);
  }, []);

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
      <div
        ref={shellRef}
        className={`nova-island-shell theme-${settings.theme} aura-${settings.aura} state-${orbState} ${
          embeddedPreview ? "is-expanded is-embedded" : "is-folded"
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
          <div ref={pillMeasureRef} className="nova-pill-measure">
            <NovaOrb
              mode={settings.avatarMode}
              aura={settings.aura}
              state={orbState}
              size={24}
              activeCount={activeAgentCount}
              activeRef={pillOrbActiveRef}
              wakeRef={pillOrbWakeRef}
            />
            <div className="nova-closed-status">
              <span className={`live-pulse-dot state-${orbState}`} />
              {pendingApprovals.length > 0 ? (
                <span className="closed-alert-text">
                  {pendingApprovals.length} {t(lang, "waitingApproval")}
                </span>
              ) : activeAgentCount > 0 ? (
                <span className="closed-active-text">
                  {(() => {
                    const live = sessions.find(
                      (s) => s.status === "active" || s.status === "waiting_approval"
                    );
                    if (live?.phase === "thinking") {
                      return lang === "th" ? "กำลังคิด…" : "Thinking…";
                    }
                    if (live?.activeTool) {
                      return live.activeTool.length > 26
                        ? `${live.activeTool.slice(0, 26)}…`
                        : live.activeTool;
                    }
                    return `${activeAgentCount} ${t(lang, "activeAgents")}`;
                  })()}
                </span>
              ) : (
                <span className="closed-idle-text">{t(lang, "idleReady")}</span>
              )}
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
            {/* TOP HEADER + UNIFIED RAYCAST-STYLE COMMAND BAR */}
            <div className="nova-island-topbar">
              <div className="nova-brand-cluster">
                <NovaOrb
                  mode={settings.avatarMode}
                  aura={settings.aura}
                  state={orbState}
                  size={32}
                  activeCount={activeAgentCount}
                  activeRef={expOrbActiveRef}
                  wakeRef={expOrbWakeRef}
                />
                <div className="nova-brand-titles">
                  <span className="nova-logo-text">NOVA</span>
                  <span className="nova-sub-badge">
                    {pendingApprovals.length > 0
                      ? `${pendingApprovals.length} ${t(lang, "waitingApproval")}`
                      : `${activeAgentCount} ${t(lang, "activeAgents")}`}
                  </span>
                </div>
              </div>

              <div className="nova-cmd-bar-wrap">
                <Search size={14} className="cmd-search-icon" />
                <input
                  ref={cmdInputRef}
                  className="nova-cmd-input"
                  value={cmdQuery}
                  onChange={(e) => setCmdQuery(e.target.value)}
                  placeholder={t(lang, "commandPlaceholder")}
                />
                <kbd className="nova-kbd">Ctrl+Alt+Space</kbd>

                {commandMatches.length > 0 && (
                  <div className="nova-cmd-dropdown">
                    {commandMatches.map((item) => (
                      <button key={item.id} className="nova-cmd-item" onClick={item.run}>
                        <span className="cmd-item-badge">{item.badge}</span>
                        <span className="cmd-item-label">{item.label}</span>
                        <ChevronRight size={13} />
                      </button>
                    ))}
                  </div>
                )}
              </div>

              <div className="nova-header-controls">
                {/* MODEL SELECTOR DROPDOWN */}
                <div className="nova-model-picker-wrap">
                  <button
                    type="button"
                    className="nova-model-btn nova-model-trigger"
                    onClick={() => setShowModelDropdown((v) => !v)}
                    title={lang === "th" ? `เลือกโมเดล (ปัจจุบัน: ${currentModel.name})` : `Select Model (Active: ${currentModel.name})`}
                  >
                    <Sparkles size={12} className="model-sparkle" />
                    <span className="model-badge-text">{currentModel.badge}</span>
                    <ChevronDown size={11} className={`model-caret ${showModelDropdown ? "open" : ""}`} />
                  </button>

                  {showModelDropdown && (
                    <div ref={modelDropdownRef} className="nova-model-dropdown">
                      <div className="model-dropdown-header">
                        <span>{lang === "th" ? "เลือกโมเดล AI" : "Select Active Model"}</span>
                      </div>
                      <div className="model-dropdown-list">
                        {AVAILABLE_MODELS.map((m) => {
                          const isSelected = m.id === currentModelId;
                          return (
                            <button
                              key={m.id}
                              type="button"
                              className={`nova-model-option ${isSelected ? "selected" : ""}`}
                              onClick={() => handleSelectModel(m.id)}
                            >
                              <div className="model-opt-info">
                                <span className="model-opt-name">{m.name}</span>
                                <span className="model-opt-provider">{m.provider.toUpperCase()}</span>
                              </div>
                              {isSelected && <Check size={14} className="model-check-icon" />}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </div>

                {/* DIRECT ACCOUNT SWITCHER */}
                <div className="nova-account-switcher-wrap">
                  <button
                    type="button"
                    className={`nova-account-pill ${activeAccount === "second" ? "is-second" : "is-main"}`}
                    onClick={() => handleToggleAccount()}
                    title={lang === "th" ? `สลับบัญชี (ปัจจุบัน: ${activeAccountName})` : `Switch Account (Active: ${activeAccountName})`}
                  >
                    <User size={12} className="account-icon" />
                    <span className="account-label">{activeAccount === "second" ? "2nd" : "Main"}</span>
                  </button>
                </div>

                {/* REAL-TIME QUOTA METER & POPOVER */}
                <div className="nova-quota-wrap">
                  <button
                    type="button"
                    className={`nova-quota-pill nova-quota-trigger status-${quotaStatus}`}
                    onClick={() => setShowQuotaPopover((v) => !v)}
                    title={lang === "th" ? "คลิกดูโควตาเรียลไทม์ & อัตราใช้งาน" : "Click to view real-time API quota & rate limits"}
                  >
                    <Gauge size={12} className="quota-icon" />
                    <span className="quota-rpm-text">{activeQuota ? `${activeQuota.rpmUsed}/${activeQuota.rpmLimit} RPM` : "Quota"}</span>
                    <span className={`quota-status-dot status-${quotaStatus}`} />
                  </button>

                  {showQuotaPopover && (
                    <div ref={quotaPopoverRef} className="nova-quota-popover">
                      <div className="quota-popover-header">
                        <div className="quota-header-left">
                          <span className="quota-popover-title">
                            {lang === "th" ? "โควตาเรียลไทม์ & บัญชี" : "Real-Time Quota & Accounts"}
                          </span>
                          <span className="quota-active-badge">
                            {activeAccount === "second" ? secondName : mainName} ({activeAccount.toUpperCase()})
                          </span>
                        </div>
                        <button
                          type="button"
                          className={`nova-btn-icon-refresh ${quotaRefreshing ? "spinning" : ""}`}
                          onClick={handleRefreshQuota}
                          title="Probe & Refresh Quota"
                        >
                          <RefreshCw size={12} />
                        </button>
                      </div>

                      {/* Rate Limit Warning / Switch Advice */}
                      {(quotaStatus === "warning" || quotaStatus === "exceeded") && (
                        <div className="quota-alert-banner">
                          <AlertTriangle size={14} className="quota-alert-icon" />
                          <div className="quota-alert-content">
                            <strong>{quotaStatus === "exceeded" ? "Rate Limit Hit (429)" : "High Quota Usage"}</strong>
                            <p>
                              {lang === "th"
                                ? "สลับไปยังบัญชีสำรองทันทีเพื่อทำงานต่ออย่างราบรื่น"
                                : "Switch to your backup account for immediate, unblocked capacity."}
                            </p>
                            <button
                              type="button"
                              className="nova-btn-switch-now"
                              onClick={() => {
                                handleToggleAccount();
                                setShowQuotaPopover(false);
                              }}
                            >
                              ⚡ {lang === "th" ? "สลับบัญชีเดี๋ยวนี้" : "Switch Account Now"}
                            </button>
                          </div>
                        </div>
                      )}

                      {/* Active Account Meter Details */}
                      <div className="quota-metrics-card">
                        <div className="quota-metric-row">
                          <span>RPM (Requests/Min):</span>
                          <strong>{activeQuota?.rpmUsed ?? 0} / {activeQuota?.rpmLimit ?? 15}</strong>
                        </div>
                        <div className="quota-progress-track">
                          <div
                            className={`quota-progress-fill status-${quotaStatus}`}
                            style={{ width: `${Math.min(100, activeQuota?.percentageUsed ?? 0)}%` }}
                          />
                        </div>

                        <div className="quota-metric-row" style={{ marginTop: 8 }}>
                          <span>RPD (Requests/Day):</span>
                          <strong>{activeQuota?.rpdUsed ?? 0} / {activeQuota?.rpdLimit ?? 1500}</strong>
                        </div>
                        <div className="quota-progress-track">
                          <div
                            className="quota-progress-fill daily"
                            style={{ width: `${Math.min(100, ((activeQuota?.rpdUsed ?? 0) / (activeQuota?.rpdLimit || 1500)) * 100)}%` }}
                          />
                        </div>

                        <div className="quota-sub-stats">
                          <span>Tokens: {(activeQuota?.totalTokensToday ?? 0).toLocaleString()}</span>
                          <span>
                            {activeQuota?.resetInSeconds && activeQuota.resetInSeconds > 0
                              ? `Reset in ${activeQuota.resetInSeconds}s`
                              : "Healthy"}
                          </span>
                        </div>
                      </div>

                      {/* Account Comparison & Quick Toggle */}
                      <div className="quota-accounts-compare">
                        <div className="compare-header">
                          <span>{lang === "th" ? "เปรียบเทียบบัญชี" : "Accounts Status"}</span>
                        </div>
                        <div className="compare-grid">
                          <div
                            className={`compare-card ${activeAccount === "main" ? "active" : ""}`}
                            onClick={() => activeAccount !== "main" && handleToggleAccount("main")}
                          >
                            <div className="compare-card-top">
                              <span className="compare-name">{mainName}</span>
                              {activeAccount === "main" && <span className="active-tag">Active</span>}
                            </div>
                            <div className="compare-stat">
                              {mainQuota ? `${mainQuota.rpmUsed}/${mainQuota.rpmLimit} RPM (${mainQuota.status})` : "Ready"}
                            </div>
                          </div>

                          <div
                            className={`compare-card ${activeAccount === "second" ? "active" : ""}`}
                            onClick={() => activeAccount !== "second" && handleToggleAccount("second")}
                          >
                            <div className="compare-card-top">
                              <span className="compare-name">{secondName}</span>
                              {activeAccount === "second" && <span className="active-tag">Active</span>}
                            </div>
                            <div className="compare-stat">
                              {secondQuota ? `${secondQuota.rpmUsed}/${secondQuota.rpmLimit} RPM (${secondQuota.status})` : (snapshot.secrets.geminiSecond ? "Ready" : "No Key")}
                            </div>
                          </div>
                        </div>
                      </div>

                      <div className="quota-popover-footer">
                        <button
                          type="button"
                          className="nova-link-btn"
                          onClick={() => {
                            setShowQuotaPopover(false);
                            novaApi.openHubWindow();
                          }}
                        >
                          ⚙️ {lang === "th" ? "ตั้งค่าคีย์ & ชื่อบัญชี" : "Configure Keys & Names in Settings"}
                        </button>
                      </div>
                    </div>
                  )}
                </div>

                <PermissionPill snapshot={snapshot} session={null} />
                <button
                  className="nova-icon-btn"
                  title="Switch Language (EN / ไทย)"
                  onClick={() =>
                    novaApi.saveSettings({
                      ...settings,
                      language: settings.language === "en" ? "th" : "en",
                    })
                  }
                >
                  <Languages size={14} />
                  <span className="tiny-lang">{settings.language.toUpperCase()}</span>
                </button>

                <button
                  className="nova-icon-btn"
                  title={settings.soundEnabled ? "Mute Sounds" : "Unmute Sounds"}
                  onClick={() =>
                    novaApi.saveSettings({ ...settings, soundEnabled: !settings.soundEnabled })
                  }
                >
                  {settings.soundEnabled ? <Volume2 size={14} /> : <VolumeX size={14} />}
                </button>

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

            {/* NAVIGATION PILLS */}
            <div className="nova-island-nav">
              <button
                className={`nova-nav-pill ${activeTab === "mission" ? "active" : ""}`}
                onClick={() => setActiveTab("mission")}
              >
                <Layers size={14} />
                <span>{t(lang, "missionControl")}</span>
                {(pendingApprovals.length > 0 || sessions.length > 0) && (
                  <span className={`pill-counter ${pendingApprovals.length > 0 ? "urgent" : ""}`}>
                    {pendingApprovals.length > 0 ? `!${pendingApprovals.length}` : sessions.length}
                  </span>
                )}
              </button>

              <button
                className={`nova-nav-pill ${activeTab === "chat" ? "active" : ""}`}
                onClick={() => setActiveTab("chat")}
              >
                <MessageSquare size={14} />
                <span>{t(lang, "quickChat")}</span>
              </button>

              <button
                className={`nova-nav-pill ${activeTab === "voice" ? "active" : ""}`}
                onClick={() => setActiveTab("voice")}
              >
                <Mic size={14} />
                <span>{t(lang, "voiceSuite")}</span>
              </button>

              <button
                className={`nova-nav-pill ${activeTab === "devtools" ? "active" : ""}`}
                onClick={() => {
                  setActiveTab("devtools");
                  onRefreshSystem();
                }}
              >
                <Zap size={14} />
                <span>{t(lang, "devTools")}</span>
                <span className="pill-counter">{ports.length}</span>
              </button>
            </div>

            {/* BODY CONTENT */}
            <div key={activeTab} className="nova-island-body nova-tab-stage">
              {/* TAB 1: MISSION CONTROL */}
              {activeTab === "mission" && (
                <div className="nova-mission-layout">
                  {pendingApprovals.length > 0 && (
                    <div className="nova-approvals-stack">
                      {pendingApprovals.map((app) => (
                        <ApprovalCard key={app.id} approval={app} lang={lang} />
                      ))}
                    </div>
                  )}

                  {sessions.length === 0 ? (
                    <div className="nova-empty-card">
                      <p>{t(lang, "noActiveSessions")}</p>
                      <div style={{ width: "100%", maxWidth: 560 }}>
                        <NewRunBar snapshot={snapshot} lang={lang} />
                      </div>
                    </div>
                  ) : (
                    <div className="nova-mission-full">
                      {/* Compact Top Project / Workspace Switcher Strip */}
                      <div className="nova-ws-topbar">
                        <div className="nova-ws-tabs">
                          {sessions.map((s) => (
                            <button
                              key={s.conversationId}
                              type="button"
                              className={`nova-ws-tab ${
                                selectedSession?.conversationId === s.conversationId
                                  ? "selected"
                                  : ""
                              }`}
                              onClick={() => setSelectedSessionId(s.conversationId)}
                              title={s.workspacePath}
                            >
                              <span className={`ws-status-dot status-${s.status}`} />
                              <FolderGit2 size={12} />
                              <span className="ws-tab-name">{s.workspaceName}</span>
                              {s.gitBranch && (
                                <span className="ws-tab-branch">
                                  <GitBranch size={10} /> {s.gitBranch}
                                </span>
                              )}
                            </button>
                          ))}
                        </div>

                        <button
                          type="button"
                          className={`ide-mini ${showNewRunDrawer ? "on" : ""}`}
                          onClick={() => setShowNewRunDrawer((v) => !v)}
                          title={lang === "th" ? "เริ่มงานใหม่เบื้องหลัง" : "Start new background task"}
                        >
                          <Plus size={11} />
                          <span>{lang === "th" ? "งานใหม่" : "New Task"}</span>
                        </button>
                      </div>

                      {showNewRunDrawer && (
                        <div className="nova-newrun-drawer">
                          <NewRunBar snapshot={snapshot} lang={lang} />
                        </div>
                      )}

                      {/* Full-Width Focused Workspace Coding Stream */}
                      {selectedSession && (
                        <div className="nova-session-detail">
                          <div className="nova-row-between">
                            <div className="nova-row-gap">
                              <strong className="detail-ws-title">
                                {selectedSession.workspaceName}
                              </strong>
                              <span className="ws-path-inline" title={selectedSession.workspacePath}>
                                {selectedSession.workspacePath}
                              </span>
                              {selectedSession.modelName && (
                                <span className="model-tag">{selectedSession.modelName}</span>
                              )}
                              {(() => {
                                const ph = getPhaseLabel(selectedSession, lang);
                                return (
                                  <span className={`phase-pill phase-${ph.key}`}>{ph.label}</span>
                                );
                              })()}
                            </div>
                            <div className="nova-btn-group">
                              <button
                                className="nova-btn nova-btn-ghost nova-btn-xs"
                                onClick={() =>
                                  novaApi.focusSessionWindow(selectedSession.conversationId)
                                }
                              >
                                <Terminal size={12} />
                                <span>{t(lang, "jumpWindow")}</span>
                              </button>
                              <button
                                className="nova-btn nova-btn-ghost nova-btn-xs"
                                onClick={() =>
                                  novaApi.openInEditor(
                                    selectedSession.workspacePath,
                                    undefined,
                                    "antigravity"
                                  )
                                }
                              >
                                <ExternalLink size={12} />
                                <span>IDE</span>
                              </button>
                            </div>
                          </div>

                          <SessionTelemetryView
                            session={selectedSession}
                            lang={lang}
                            compact
                          />

                          <SessionCockpit snapshot={snapshot} session={selectedSession} lang={lang} />
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
                        onClick={() => setShowQuotaPopover((v) => !v)}
                        title={`Quota: ${activeQuota ? `${activeQuota.rpmUsed}/${activeQuota.rpmLimit} RPM` : "Ready"}`}
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
                      onClick={() => novaApi.newChatThread()}
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
                        <div className="chat-text">{m.content}</div>
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
