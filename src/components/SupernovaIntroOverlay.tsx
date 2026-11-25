import React, { useEffect, useRef } from "react";
import { playSupernovaBootAudio, stopSupernovaBootAudio } from "../lib/soundEngine";

interface SupernovaIntroOverlayProps {
  active: boolean;
  runKey: number;
  soundEnabled: boolean;
  getPillMetrics: () => { x: number; y: number; w: number; h: number };
  isBottomDock: boolean;
  idleLabel: string;
  onDockUnfurlProgress?: (capsuleAlpha: number) => void;
  onComplete: () => void;
}

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const easeOutCubic = (t: number) => 1 - Math.pow(1 - clamp(t, 0, 1), 3);
const easeOutQuart = (t: number) => 1 - Math.pow(1 - clamp(t, 0, 1), 4);
const easeInOutCubic = (t: number) => {
  const x = clamp(t, 0, 1);
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
};
const easeOutBack = (t: number, overshoot = 1.55) => {
  const x = clamp(t, 0, 1);
  const c3 = overshoot + 1;
  return 1 + c3 * Math.pow(x - 1, 3) + overshoot * Math.pow(x - 1, 2);
};

// Palette 1: Obsidian + Starlight White + Lavender Violet (#a78bfa) + Sapphire Ice-Blue (#60a5fa)
const STARDUST = Array.from({ length: 62 }, (_, i) => ({
  angle: (i / 62) * Math.PI * 2 + (i % 5) * 0.15,
  dist: 35 + (i % 8) * 15,
  speed: 0.74 + (i % 5) * 0.24,
  size: 1.05 + (i % 4) * 0.72,
  col: ["#ffffff", "#c4b5fd", "#a78bfa", "#60a5fa", "#93c5fd"][i % 5],
}));

function drawSoftCloud(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  rx: number,
  ry: number,
  rotRad: number,
  r: number,
  g: number,
  b: number,
  peakAlpha: number
) {
  if (peakAlpha <= 0.003 || rx <= 1 || ry <= 1) return;
  ctx.save();
  ctx.translate(x, y);
  if (rotRad) ctx.rotate(rotRad);
  ctx.scale(rx, ry);
  const grad = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
  grad.addColorStop(0, `rgba(${r}, ${g}, ${b}, ${clamp(peakAlpha, 0, 1)})`);
  grad.addColorStop(0.45, `rgba(${r}, ${g}, ${b}, ${clamp(peakAlpha * 0.42, 0, 1)})`);
  grad.addColorStop(0.78, `rgba(${r}, ${g}, ${b}, ${clamp(peakAlpha * 0.1, 0, 1)})`);
  grad.addColorStop(1, `rgba(${r}, ${g}, ${b}, 0)`);
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.arc(0, 0, 1, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function drawRoundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
) {
  const cr = Math.max(0, Math.min(r, w * 0.5, h * 0.5));
  ctx.beginPath();
  ctx.moveTo(x + cr, y);
  ctx.arcTo(x + w, y, x + w, y + h, cr);
  ctx.arcTo(x + w, y + h, x, y + h, cr);
  ctx.arcTo(x, y + h, x, y, cr);
  ctx.arcTo(x, y, x + w, y, cr);
  ctx.closePath();
}

function drawFourPointStar(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  outerR: number,
  innerR: number,
  color: string,
  alpha = 1
) {
  if (alpha <= 0.01 || outerR <= 0.5) return;
  ctx.save();
  ctx.globalAlpha = clamp(alpha, 0, 1);
  ctx.fillStyle = color;
  ctx.beginPath();
  for (let i = 0; i < 8; i++) {
    const a = (i * Math.PI) / 4;
    const r = i % 2 === 0 ? outerR : innerR;
    const px = x + Math.cos(a) * r;
    const py = y + Math.sin(a) * r;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function drawNovaMascot(
  ctx: CanvasRenderingContext2D,
  opts: {
    cx: number;
    cy: number;
    size: number;
    alpha?: number;
    yaw?: number;
    pitch?: number;
    eyeOpen?: number;
    happySmile?: number;
    ringScale?: number;
    moonAngle?: number;
    moonTrail?: number;
    glowBoost?: number;
  }
) {
  const {
    cx,
    cy,
    size,
    alpha = 1,
    yaw = 0,
    pitch = 0,
    eyeOpen = 1,
    happySmile = 0,
    ringScale = 1,
    moonAngle = 0.58,
    moonTrail = 0,
    glowBoost = 0,
  } = opts;
  if (size <= 1 || alpha <= 0.005) return;

  ctx.save();
  ctx.globalAlpha = clamp(alpha, 0, 1);

  const baseR = size * 0.34;
  const coreR = baseR * 0.94;
  const ringR = baseR * 1.17 * ringScale;

  const haloR = size * (0.5 + glowBoost * 0.26);
  drawSoftCloud(ctx, cx, cy, haloR, haloR, 0, 167, 139, 250, (0.28 + glowBoost * 0.34) * alpha);

  ctx.strokeStyle = "rgba(167, 139, 250, 0.68)";
  ctx.lineWidth = Math.max(1.1, size * 0.035);
  ctx.beginPath();
  ctx.arc(cx, cy, ringR, 0, Math.PI * 2);
  ctx.stroke();

  ctx.fillStyle = "#a78bfa";
  ctx.beginPath();
  ctx.arc(cx, cy, coreR, 0, Math.PI * 2);
  ctx.fill();

  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, coreR, 0, Math.PI * 2);
  ctx.clip();

  const eyeW = Math.max(1.5, size * 0.078);
  const eyeH = Math.max(3.1, size * 0.168);
  ctx.fillStyle = "rgba(3, 5, 12, 0.94)";
  ctx.strokeStyle = "rgba(3, 5, 12, 0.94)";

  for (const sd of [-1, 1]) {
    const eyeYaw = sd * 0.34 + yaw;
    const eyePitch = 0.06 + pitch;
    const cp = Math.cos(eyePitch);
    const ex = cx + Math.sin(eyeYaw) * cp * (coreR * 0.86);
    const ey = cy - Math.sin(eyePitch) * (coreR * 0.84);
    const fx = Math.max(0.24, Math.cos(eyeYaw));
    const fy = Math.max(0.28, cp);

    ctx.save();
    ctx.translate(ex, ey);
    ctx.scale(fx, fy);
    if (happySmile > 0.5) {
      ctx.lineWidth = Math.max(1.6, eyeW * 0.82);
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.arc(0, eyeH * 0.18, eyeW * 0.88, Math.PI * 1.15, Math.PI * 1.85);
      ctx.stroke();
    } else {
      const hh = Math.max(eyeH * clamp(eyeOpen, 0.08, 1.15), eyeW * 0.34);
      drawRoundedRect(ctx, -eyeW * 0.5, -hh * 0.5, eyeW, hh, eyeW * 0.5);
      ctx.fill();
    }
    ctx.restore();
  }
  ctx.restore();

  if (moonTrail > 0.02) {
    const steps = 9;
    for (let k = 1; k <= steps; k++) {
      const ta = moonAngle - k * 0.1 * moonTrail;
      ctx.fillStyle = `rgba(221, 214, 254, ${(1 - k / (steps + 1)) * 0.45 * moonTrail})`;
      ctx.beginPath();
      ctx.arc(
        cx + Math.cos(ta) * ringR,
        cy + Math.sin(ta) * ringR,
        Math.max(0.9, size * 0.036 * (1 - k / (steps + 2))),
        0,
        Math.PI * 2
      );
      ctx.fill();
    }
  }

  const mx = cx + Math.cos(moonAngle) * ringR;
  const my = cy + Math.sin(moonAngle) * ringR;
  const mr = Math.max(2.4, size * 0.115);
  const mGlow = ctx.createRadialGradient(mx, my, 0, mx, my, mr);
  mGlow.addColorStop(0, "rgba(255, 255, 255, 0.85)");
  mGlow.addColorStop(0.5, "rgba(167, 139, 250, 0.36)");
  mGlow.addColorStop(1, "rgba(167, 139, 250, 0)");
  ctx.fillStyle = mGlow;
  ctx.beginPath();
  ctx.arc(mx, my, mr, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = "#ffffff";
  ctx.beginPath();
  ctx.arc(mx, my, Math.max(1.0, size * 0.044), 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function drawDockingCapsule(
  ctx: CanvasRenderingContext2D,
  cx: number,
  topY: number,
  curW: number,
  pillH: number,
  alpha: number,
  rimGlow: number,
  labelAlpha: number,
  idleLabel: string
) {
  if (alpha <= 0.005) return;
  ctx.save();
  ctx.globalAlpha = clamp(alpha, 0, 1);

  const x = cx - curW * 0.5;
  const r = pillH * 0.5;

  ctx.shadowColor = "rgba(0, 0, 0, 0.58)";
  ctx.shadowBlur = 18;
  ctx.shadowOffsetY = 6;

  ctx.fillStyle = "#0e0e11";
  drawRoundedRect(ctx, x, topY, curW, pillH, r);
  ctx.fill();
  ctx.shadowColor = "transparent";

  if (labelAlpha > 0.01 && curW > pillH + 24) {
    ctx.save();
    drawRoundedRect(ctx, x, topY, curW, pillH, r);
    ctx.clip();
    ctx.globalAlpha = alpha * clamp(labelAlpha, 0, 1);

    // Live violet status dot + resting status label matching .nova-pill-measure
    const dotX = x + 44 + (1 - labelAlpha) * -5;
    const dotY = topY + pillH * 0.5;
    ctx.fillStyle = "#a78bfa";
    ctx.beginPath();
    ctx.arc(dotX, dotY, 3.2, 0, Math.PI * 2);
    ctx.fill();

    ctx.font = '500 12px "Segoe UI Variable Display", "Segoe UI", system-ui, sans-serif';
    ctx.fillStyle = "#e2e8f0";
    ctx.textBaseline = "middle";
    ctx.fillText(idleLabel, dotX + 10, dotY + 0.5);
    ctx.restore();
  }

  ctx.strokeStyle =
    rimGlow > 0.01 ? `rgba(167, 139, 250, ${0.2 + rimGlow * 0.68})` : "rgba(255, 255, 255, 0.13)";
  ctx.lineWidth = 1 + rimGlow * 0.5;
  drawRoundedRect(ctx, x, topY, curW, pillH, r);
  ctx.stroke();
  ctx.restore();
}

export const SupernovaIntroOverlay: React.FC<SupernovaIntroOverlayProps> = ({
  active,
  runKey,
  soundEnabled,
  getPillMetrics,
  isBottomDock,
  idleLabel,
  onDockUnfurlProgress,
  onComplete,
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const geomRef = useRef({ getPillMetrics, isBottomDock, idleLabel, soundEnabled });
  geomRef.current = { getPillMetrics, isBottomDock, idleLabel, soundEnabled };

  const callbacksRef = useRef({ onDockUnfurlProgress, onComplete });
  callbacksRef.current = { onDockUnfurlProgress, onComplete };

  useEffect(() => {
    if (!active) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let rafId = 0;
    let warmupFrames = 0;
    let startMs = 0;
    let audioStarted = false;
    let handedOff = false;
    let finishedNaturally = false;

    const TOTAL_DURATION = 3.75;
    const HANDOFF_START = 3.55;

    const step = (now: number) => {
      // Wait 2 rAF frames so WebView2 swapchain & DWM composition are 100% live before t=0!
      if (warmupFrames < 2) {
        warmupFrames += 1;
        rafId = window.requestAnimationFrame(step);
        return;
      }
      if (!audioStarted) {
        audioStarted = true;
        startMs = now;
        playSupernovaBootAudio(geomRef.current.soundEnabled);
      }

      const dpr = window.devicePixelRatio || 1;
      const W = window.innerWidth || 900;
      const H = window.innerHeight || 690;
      if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) {
        canvas.width = Math.round(W * dpr);
        canvas.height = Math.round(H * dpr);
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);

      const {
        getPillMetrics: readMetrics,
        isBottomDock: bottom,
        idleLabel: label,
      } = geomRef.current;
      const { x: pX, y: pY, w: pW, h: pH } = readMetrics();

      const cx = pX + pW * 0.5;
      const heroY = bottom ? Math.max(120, pY - 120) : Math.min(H - 120, pY + pH * 0.5 + 118);
      const ORB_REST_SIZE = 24;

      const elapsed = (now - startMs) / 1000;

      // Cross-dissolve over final 200ms onto the real DOM Dynamic Island capsule at the exact same pixels
      const overlayAlpha =
        elapsed >= HANDOFF_START
          ? 1 - easeInOutCubic(clamp((elapsed - HANDOFF_START) / (TOTAL_DURATION - HANDOFF_START), 0, 1))
          : 1;
      if (elapsed >= HANDOFF_START && !handedOff) {
        handedOff = true;
        callbacksRef.current.onDockUnfurlProgress?.(1);
      } else if (elapsed < HANDOFF_START) {
        const realReveal = clamp((elapsed - 3.45) / 0.18, 0, 1);
        callbacksRef.current.onDockUnfurlProgress?.(realReveal);
      }

      ctx.save();
      ctx.globalAlpha = overlayAlpha;

      // Palette 1 Nebula Envelope (Violet #8b5cf6 + Sapphire Ice-Blue #60a5fa + Periwinkle #818cf8; 100% gone by 2.90s!)
      const nebEnv =
        elapsed < 0.2
          ? (elapsed / 0.2) * 0.35
          : elapsed < 0.86
          ? lerp(0.35, 0.78, (elapsed - 0.2) / 0.66)
          : elapsed < 1.95
          ? 1.0
          : 1 - easeInOutCubic(clamp((elapsed - 1.95) / 0.95, 0, 1));

      if (nebEnv > 0.004) {
        drawSoftCloud(ctx, cx - 38 + Math.sin(elapsed * 1.1) * 12, heroY - 12, 142, 110, 0.2, 139, 92, 246, 0.32 * nebEnv);
        drawSoftCloud(ctx, cx + 42 - Math.cos(elapsed * 0.95) * 12, heroY + 14, 136, 102, -0.25, 96, 165, 250, 0.25 * nebEnv);
        drawSoftCloud(ctx, cx, heroY - 4, 110, 95, 0, 129, 140, 248, 0.23 * nebEnv);
      }

      // Act I (0.00s – 0.86s): Singularity Implosion + Cinema Cross-Flare
      if (elapsed < 0.86) {
        const p = elapsed / 0.86;
        const pull = 1 - easeInOutCubic(p);

        STARDUST.forEach((pt) => {
          const r = pt.dist * (0.06 + 1.42 * pull);
          const a = pt.angle + elapsed * pt.speed * 3.1;
          ctx.fillStyle = pt.col;
          ctx.globalAlpha = overlayAlpha * clamp(p * 1.5, 0, 0.92);
          ctx.beginPath();
          ctx.arc(cx + Math.cos(a) * r, heroY + Math.sin(a) * r * 0.72, pt.size, 0, Math.PI * 2);
          ctx.fill();
        });
        ctx.globalAlpha = overlayAlpha;

        const starR = 3 + easeInOutCubic(p) * 10.5;
        drawSoftCloud(ctx, cx, heroY, starR * 5.2, starR * 5.2, 0, 196, 181, 253, 0.92);
        drawSoftCloud(ctx, cx, heroY, starR * 2.1, starR * 2.1, 0, 255, 255, 255, 1.0);

        const flareP = Math.sin(p * Math.PI);
        const span = 170;
        const hGrad = ctx.createLinearGradient(cx - span * flareP, heroY, cx + span * flareP, heroY);
        hGrad.addColorStop(0, "rgba(255,255,255,0)");
        hGrad.addColorStop(0.5, `rgba(255,255,255,${0.92 * flareP})`);
        hGrad.addColorStop(1, "rgba(255,255,255,0)");
        ctx.fillStyle = hGrad;
        ctx.fillRect(cx - span * flareP, heroY - 1.2, span * 2 * flareP, 2.4);

        const vGrad = ctx.createLinearGradient(cx, heroY - 75 * flareP, cx, heroY + 75 * flareP);
        vGrad.addColorStop(0, "rgba(196,181,253,0)");
        vGrad.addColorStop(0.5, `rgba(255,255,255,${0.75 * flareP})`);
        vGrad.addColorStop(1, "rgba(196,181,253,0)");
        ctx.fillStyle = vGrad;
        ctx.fillRect(cx - 1, heroY - 75 * flareP, 2, 150 * flareP);

        drawFourPointStar(ctx, cx, heroY, 20 * p, 3.4 * p, "#ffffff", 0.96);
      }
      // Act II (0.86s – 2.42s): Supernova Shockwave + Hero NOVA Wakes & Smiles (^^)
      else if (elapsed < 2.42) {
        const p = (elapsed - 0.86) / 1.56;

        if (p < 0.78) {
          const sp = p / 0.78;
          const w1 = 16 + easeOutQuart(sp) * 148;
          const w2 = 10 + easeOutCubic(sp) * 106;

          ctx.strokeStyle = `rgba(196, 181, 253, ${(1 - sp) * 0.84})`;
          ctx.lineWidth = 2.6 * (1 - sp * 0.7);
          ctx.beginPath();
          ctx.arc(cx, heroY, w1, 0, Math.PI * 2);
          ctx.stroke();

          ctx.strokeStyle = `rgba(96, 165, 250, ${(1 - sp) * 0.58})`;
          ctx.lineWidth = 1.5 * (1 - sp * 0.6);
          ctx.beginPath();
          ctx.arc(cx, heroY, w2, 0, Math.PI * 2);
          ctx.stroke();

          STARDUST.forEach((pt, idx) => {
            const r = 14 + easeOutCubic(sp) * (pt.dist * 1.54);
            const a = pt.angle + sp * 0.65;
            const px = cx + Math.cos(a) * r;
            const py = heroY + Math.sin(a) * r * 0.78;
            if (idx % 6 === 0) {
              drawFourPointStar(ctx, px, py, 5.8 * (1 - sp), 1.4, "#ffffff", (1 - sp) * 0.95);
            } else {
              ctx.fillStyle = pt.col;
              ctx.globalAlpha = overlayAlpha * (1 - sp) * 0.9;
              ctx.beginPath();
              ctx.arc(px, py, pt.size * 1.15, 0, Math.PI * 2);
              ctx.fill();
            }
          });
          ctx.globalAlpha = overlayAlpha;
        }

        const popScale = easeOutBack(clamp(p / 0.34, 0, 1), 1.55);
        const wakeOpen = p < 0.16 ? 0.08 : clamp((p - 0.16) / 0.14, 0.08, 1);
        const yaw = p > 0.28 && p < 0.55 ? Math.sin(((p - 0.28) / 0.27) * Math.PI * 2) * 0.36 : 0;
        const smile = p > 0.56 && p < 0.92 ? 1 : 0;
        const bobY = heroY + Math.sin(p * Math.PI * 2) * 3.5;

        drawNovaMascot(ctx, {
          cx,
          cy: bobY,
          size: 94 * popScale,
          yaw,
          pitch: smile ? 0.08 : 0.02,
          eyeOpen: wakeOpen,
          happySmile: smile,
          ringScale: 0.86 + 0.14 * easeOutCubic(clamp(p / 0.42, 0, 1)),
          moonAngle: -1.9 + easeOutCubic(p) * 2.48,
          moonTrail: Math.sin(clamp(p / 0.7, 0, 1) * Math.PI) * 0.85,
          glowBoost: (1 - p) * 0.7,
        });
      }
      // Act III (2.42s – 3.75s): Ascent + Dead-Center Circle Dock + Clean Resting Pill Handoff
      else {
        const dockP = clamp((elapsed - 2.42) / 0.68, 0, 1);
        const unfurlP = clamp((elapsed - 3.0) / 0.56, 0, 1);
        const eDock = easeInOutCubic(dockP);
        const eUnfurl = easeOutCubic(unfurlP);

        const pillAlpha = clamp((dockP - 0.36) / 0.44, 0, 1);
        const curPillW = lerp(pH, pW, eUnfurl);
        const rimGlow = dockP > 0.45 ? Math.sin(clamp((elapsed - 2.8) / 0.78, 0, 1) * Math.PI) : 0;

        drawDockingCapsule(
          ctx,
          cx,
          pY,
          curPillW,
          pH,
          pillAlpha,
          rimGlow,
          clamp((eUnfurl - 0.2) / 0.8, 0, 1),
          label
        );

        // 100% dead-center inside pH x pH circle when eUnfurl == 0, gliding to exact .nova-pill-measure orb slot (left + 20px)!
        const curLeft = cx - curPillW * 0.5;
        const targetDockX = lerp(cx, curLeft + 20, eUnfurl);
        const orbX = lerp(cx, targetDockX, eDock);
        const orbY = lerp(heroY, pY + pH * 0.5, eDock);
        const orbSize = lerp(94, ORB_REST_SIZE, eDock);

        drawNovaMascot(ctx, {
          cx: orbX,
          cy: orbY,
          size: orbSize,
          moonAngle: 0.58 + (elapsed - 2.42) * 0.55,
          glowBoost: (1 - eDock) * 0.25,
        });
      }

      ctx.restore();

      if (elapsed < TOTAL_DURATION) {
        rafId = window.requestAnimationFrame(step);
      } else {
        finishedNaturally = true;
        callbacksRef.current.onDockUnfurlProgress?.(1);
        callbacksRef.current.onComplete();
      }
    };

    rafId = window.requestAnimationFrame(step);
    return () => {
      if (rafId) window.cancelAnimationFrame(rafId);
      // Only cut the soundtrack if the intro was interrupted (hover/replay).
      // When it finishes naturally, the echo tail rings out past the visuals.
      if (!finishedNaturally) stopSupernovaBootAudio();
    };
  }, [active, runKey]);

  if (!active) return null;

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      style={{
        position: "absolute",
        inset: 0,
        width: "100%",
        height: "100%",
        pointerEvents: "none",
        zIndex: 12,
      }}
    />
  );
};
