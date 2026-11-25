import React, { useEffect, useRef } from "react";
import { isTauriRuntime, novaApi } from "../lib/novaClient";

export type OrbState = "idle" | "active" | "alert" | "listening";
export type OrbAura = "cyan" | "amber" | "violet" | "emerald";

interface NovaOrbProps {
  mode: "orb" | "hud";
  aura: OrbAura;
  state: OrbState;
  size?: number;
  activeCount?: number;
}

const AURA_COLORS: Record<OrbAura, { primary: string; secondary: string; rgb: [number, number, number] }> = {
  cyan: { primary: "#22d3ee", secondary: "#818cf8", rgb: [34, 211, 238] },
  amber: { primary: "#fbbf24", secondary: "#f97316", rgb: [251, 191, 36] },
  violet: { primary: "#a78bfa", secondary: "#f472b6", rgb: [167, 139, 250] },
  emerald: { primary: "#34d399", secondary: "#2dd4bf", rgb: [52, 211, 153] },
};

// Coucou spherical eye constants (yaw spacing & base upward pitch in radians)
const EYE_SP = 0.34;
const EYE_P = 0.06;

function drawRoundedPill(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number
) {
  const r = Math.max(0, Math.min(w * 0.5, h * 0.5));
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

export const NovaOrb: React.FC<NovaOrbProps> = ({
  mode,
  aura,
  state,
  size = 34,
  activeCount = 0,
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const stateRef = useRef<OrbState>(state);
  const auraRef = useRef<OrbAura>(aura);
  stateRef.current = state;
  auraRef.current = aura;

  // Persistent gaze & blink physics across state/aura changes so eyes never reset mid-look
  const gazeRef = useRef({
    lookX: 0,
    lookY: 0,
    hasPointer: false,
    lastMoveMs: 0,
    yaw: 0,
    pitch: 0,
    wanderX: 0,
    wanderY: 0,
    nextWanderMs: 0,
    blinkStartMs: 0,
    doubleBlinkAtMs: 0,
    nextBlinkMs: 0,
    squintStartMs: 0,
  });
  const orbitBurstStartRef = useRef(0);

  const handleOrbClick = () => {
    const nowMs = performance.now();
    gazeRef.current.squintStartMs = nowMs;
    // Don't restart a burst mid-flight; that would jump the moon's phase.
    if (orbitBurstStartRef.current <= 0 || nowMs - orbitBurstStartRef.current >= 5000) {
      orbitBurstStartRef.current = nowMs;
    }
  };

  useEffect(() => {
    if (mode !== "orb") return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = size * dpr;
    canvas.height = size * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    let rafId = 0;
    let phase = 0;
    let moonPhase = 0;
    let lastFrame = performance.now();
    let lastRectSync = 0;
    let cachedCenterX = 0;
    let cachedCenterY = 0;
    let hasCachedCenter = false;

    const syncCanvasCenter = (nowMs: number) => {
      const rect = canvas.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        cachedCenterX = rect.left + rect.width * 0.5;
        cachedCenterY = rect.top + rect.height * 0.5;
        hasCachedCenter = true;
        lastRectSync = nowMs;
      }
    };

    syncCanvasCenter(lastFrame);

    const g = gazeRef.current;
    if (g.nextBlinkMs === 0) {
      g.nextBlinkMs = lastFrame + 1600 + Math.random() * 2400;
      g.nextWanderMs = lastFrame + 2500 + Math.random() * 3000;
    }

    const updateGaze = (clientX: number, clientY: number) => {
      const nowMs = performance.now();
      if (!hasCachedCenter || nowMs - lastRectSync > 90) {
        syncCanvasCenter(nowMs);
      }
      if (!hasCachedCenter) return;

      const dx = clientX - cachedCenterX;
      const dy = clientY - cachedCenterY;

      // Coucou's exact `Math.tanh` distance curve (`lookX` right +, `lookY` up +)
      g.lookX = Math.tanh(dx / 240);
      g.lookY = -Math.tanh(dy / 190);
      g.hasPointer = true;
      g.lastMoveMs = nowMs;
    };

    const onMouseMove = (event: MouseEvent) => updateGaze(event.clientX, event.clientY);
    window.addEventListener("mousemove", onMouseMove, { passive: true });
    const onResize = () => syncCanvasCenter(performance.now());
    window.addEventListener("resize", onResize);

    let unlistenPointer: (() => void) | undefined;
    if (isTauriRuntime()) {
      void novaApi.onIslandPointer(({ x, y }) => updateGaze(x, y)).then((unlisten) => {
        unlistenPointer = unlisten;
      });
    }

    const computeBlinkOpen = (nowMs: number): number => {
      if (g.doubleBlinkAtMs > 0 && nowMs >= g.doubleBlinkAtMs) {
        g.blinkStartMs = g.doubleBlinkAtMs;
        g.doubleBlinkAtMs = 0;
      }
      if (nowMs >= g.nextBlinkMs) {
        g.blinkStartMs = nowMs;
        if (Math.random() < 0.22) {
          g.doubleBlinkAtMs = nowMs + 230;
        }
        g.nextBlinkMs = nowMs + 2200 + Math.random() * 3200;
      }
      if (g.blinkStartMs <= 0) return 1;
      const elapsed = nowMs - g.blinkStartMs;
      // Coucou blink timing: 70ms close to 0.06, 130ms ease-out open back to 1.0
      if (elapsed < 70) {
        const t = elapsed / 70;
        const ease = t * t * (3 - 2 * t);
        return 1 - 0.94 * ease;
      }
      if (elapsed < 200) {
        const t = (elapsed - 70) / 130;
        const easeOut = 1 - (1 - t) * (1 - t);
        return 0.06 + 0.94 * easeOut;
      }
      g.blinkStartMs = 0;
      return 1;
    };

    const render = () => {
      const curState = stateRef.current;
      const curAura = auraRef.current;
      const palette =
        curState === "alert" ? AURA_COLORS.amber : AURA_COLORS[curAura] ?? AURA_COLORS.cyan;
      const [r, green, b] = palette.rgb;

      const nowMs = performance.now();
      const dtMs = Math.min(40, Math.max(1, nowMs - lastFrame));
      const dtSec = dtMs / 1000;
      lastFrame = nowMs;

      if (nowMs - lastRectSync > 180) {
        syncCanvasCenter(nowMs);
      }

      const motionRate =
        curState === "alert"
          ? 0.0014
          : curState === "listening"
          ? 0.0012
          : curState === "active"
          ? 0.0009
          : 0.00022;
      phase += dtMs * motionRate;
      moonPhase += dtMs * (curState === "idle" ? 0.0002 : curState === "active" ? 0.0004 : 0.0005);

      // Keep tracking the cursor continuously across all states (including idle!).
      // Only drift into gentle autonomous glances if the mouse hasn't moved for >8s.
      const pointerRestingLong = !g.hasPointer || nowMs - g.lastMoveMs > 8500;
      if (pointerRestingLong && nowMs >= g.nextWanderMs) {
        g.wanderX = (Math.random() * 2 - 1) * 0.55;
        g.wanderY = (Math.random() * 2 - 1) * 0.25;
        g.nextWanderMs = nowMs + 2600 + Math.random() * 3400;
      }

      const activeLookX = pointerRestingLong ? g.wanderX : g.lookX;
      const activeLookY = pointerRestingLong ? g.wanderY : g.lookY;

      // Coucou spherical target angles & exponential smoothing (`1 - 0.0025^dt`)
      const tgYaw = activeLookX * 0.68;
      const tgPitch = activeLookY * 0.54;
      const kLook = 1 - Math.pow(0.0025, dtSec);
      g.yaw += (tgYaw - g.yaw) * kLook;
      g.pitch += (tgPitch - g.pitch) * kLook;

      const blinkOpen = computeBlinkOpen(nowMs);
      const squintElapsed = nowMs - g.squintStartMs;
      let clickSquintOpen = 1;
      if (g.squintStartMs > 0 && squintElapsed < 520) {
        clickSquintOpen = 1 - 0.84 * Math.sin(Math.PI * (squintElapsed / 520));
      } else if (g.squintStartMs > 0) {
        g.squintStartMs = 0;
      }
      const eyeOpen = Math.min(blinkOpen, clickSquintOpen);

      ctx.clearRect(0, 0, size, size);
      const cx = size / 2;
      const cy = size / 2;
      const baseR = size * 0.34;

      // Ambient aura halo
      const halo = ctx.createRadialGradient(cx, cy, baseR * 0.15, cx, cy, size * 0.49);
      halo.addColorStop(0, `rgba(${r}, ${green}, ${b}, 0.3)`);
      halo.addColorStop(0.7, `rgba(${r}, ${green}, ${b}, 0.08)`);
      halo.addColorStop(1, `rgba(${r}, ${green}, ${b}, 0)`);
      ctx.fillStyle = halo;
      ctx.beginPath();
      ctx.arc(cx, cy, size * 0.49, 0, Math.PI * 2);
      ctx.fill();

      // Orbital ring
      const ringRadius = baseR * 1.17;
      ctx.strokeStyle = `rgba(${r}, ${green}, ${b}, 0.56)`;
      ctx.lineWidth = Math.max(1, size * 0.035);
      ctx.beginPath();
      ctx.arc(cx, cy, ringRadius, 0, Math.PI * 2);
      ctx.stroke();

      // Solid purple core
      const pulse =
        curState === "idle" ? 1 + 0.006 * Math.sin(phase) : 1 + 0.025 * Math.sin(phase * 1.8);
      const coreR = baseR * 0.94 * pulse;
      ctx.fillStyle = "#a78bfa";
      ctx.beginPath();
      ctx.arc(cx, cy, coreR, 0, Math.PI * 2);
      ctx.fill();

      // Coucou-style 3D spherical eyes clipped inside NOVA's purple core
      ctx.save();
      ctx.beginPath();
      ctx.arc(cx, cy, coreR, 0, Math.PI * 2);
      ctx.clip();

      const eyeW = Math.max(1.5, size * 0.078);
      const eyeH = Math.max(3.3, size * 0.168);
      ctx.fillStyle = "rgba(3, 5, 12, 0.94)";

      for (const sd of [-1, 1]) {
        const eyeYaw = sd * EYE_SP + g.yaw;
        const eyePitch = EYE_P + g.pitch;
        const cp = Math.cos(eyePitch);
        if (Math.cos(eyeYaw) * cp <= 0.04) continue;

        const ex = cx + Math.sin(eyeYaw) * cp * (coreR * 0.86);
        const ey = cy - Math.sin(eyePitch) * (coreR * 0.84);
        // 3D perspective foreshortening near the sphere's limb
        const fx = Math.max(0.24, Math.cos(eyeYaw));
        const fy = Math.max(0.28, cp);
        const hh = Math.max(eyeH * eyeOpen, eyeW * 0.34);

        ctx.save();
        ctx.translate(ex, ey);
        ctx.scale(fx, fy);
        drawRoundedPill(ctx, -eyeW * 0.5, -hh * 0.5, eyeW, hh);
        ctx.fill();
        ctx.restore();
      }
      ctx.restore();

      // Orbiting moon along the ring
      const burstElapsed = nowMs - orbitBurstStartRef.current;
      const burstProgress = Math.max(0, Math.min(1, burstElapsed / 5000));
      const easedBurst = burstProgress * burstProgress * (3 - 2 * burstProgress);
      const bonusOrbit = orbitBurstStartRef.current > 0 && burstProgress < 1 ? Math.PI * 2 * easedBurst : 0;
      const visibleMoonPhase = moonPhase + bonusOrbit;
      const moonX = cx + Math.cos(visibleMoonPhase) * ringRadius;
      const moonY = cy + Math.sin(visibleMoonPhase) * ringRadius;
      ctx.fillStyle = "rgba(255, 255, 255, 0.2)";
      ctx.beginPath();
      ctx.arc(moonX, moonY, Math.max(1.9, size * 0.085), 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "rgba(255, 255, 255, 0.96)";
      ctx.beginPath();
      ctx.arc(moonX, moonY, Math.max(0.95, size * 0.043), 0, Math.PI * 2);
      ctx.fill();

      rafId = requestAnimationFrame(render);
    };

    rafId = requestAnimationFrame(render);
    return () => {
      cancelAnimationFrame(rafId);
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("resize", onResize);
      unlistenPointer?.();
    };
  }, [mode, size]);

  if (mode === "hud") {
    const palette = state === "alert" ? AURA_COLORS.amber : AURA_COLORS[aura] ?? AURA_COLORS.cyan;
    return (
      <div
        className={`nova-hud-glyph state-${state}`}
        style={{ borderColor: palette.primary, color: palette.primary }}
        title="NOVA Pro HUD Mode"
      >
        <span className="nova-hud-dot" style={{ backgroundColor: palette.primary }} />
        <span className="nova-hud-tag">NV</span>
        {activeCount > 0 && <span className="nova-hud-count">{activeCount}</span>}
      </div>
    );
  }

  return (
    <canvas
      ref={canvasRef}
      style={{ width: size, height: size, cursor: "pointer", flexShrink: 0 }}
      onClick={handleOrbClick}
    />
  );
};
