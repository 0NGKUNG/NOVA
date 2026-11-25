import React, { useEffect, useRef } from "react";
import { playSupernovaBootAudio, stopSupernovaBootAudio } from "../lib/soundEngine";

interface SupernovaIntroOverlayProps {
  active: boolean;
  runKey: number;
  soundEnabled: boolean;
  getPillMetrics: () => { x: number; y: number; w: number; h: number };
  isBottomDock: boolean;
  idleLabel: string;
  onIntroFrame?: (frame: {
    elapsed: number;
    centerX: number;
    heroY: number;
    pillX: number;
    pillY: number;
    pillW: number;
    pillH: number;
    bottom: boolean;
  }) => void;
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

export const SupernovaIntroOverlay: React.FC<SupernovaIntroOverlayProps> = ({
  active,
  runKey,
  soundEnabled,
  getPillMetrics,
  isBottomDock,
  idleLabel,
  onIntroFrame,
  onDockUnfurlProgress,
  onComplete,
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const geomRef = useRef({ getPillMetrics, isBottomDock, idleLabel, soundEnabled });
  geomRef.current = { getPillMetrics, isBottomDock, idleLabel, soundEnabled };

  const callbacksRef = useRef({ onIntroFrame, onDockUnfurlProgress, onComplete });
  callbacksRef.current = { onIntroFrame, onDockUnfurlProgress, onComplete };

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
    let finishedNaturally = false;

    const TOTAL_DURATION = 3.75;
    const initRect = canvas.getBoundingClientRect();
    let stageW = initRect.width || window.innerWidth || 900;
    let stageH = initRect.height || window.innerHeight || 690;
    const onWinResize = () => {
      stageW = window.innerWidth || 900;
      stageH = window.innerHeight || 690;
    };
    window.addEventListener("resize", onWinResize);

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

      const dpr = Math.max(2, window.devicePixelRatio || 1);
      const W = stageW;
      const H = stageH;
      if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) {
        canvas.width = Math.round(W * dpr);
        canvas.height = Math.round(H * dpr);
      }
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
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

      const elapsed = (now - startMs) / 1000;
      callbacksRef.current.onIntroFrame?.({
        elapsed,
        centerX: cx,
        heroY,
        pillX: pX,
        pillY: pY,
        pillW: pW,
        pillH: pH,
        bottom,
      });

      // This canvas only paints the surrounding ignition light and particles.
      const overlayAlpha = 1;

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
        // Rich, tight cosmic glow (avoids milky wide-radius haze over desktop text)
        drawSoftCloud(ctx, cx - 32 + Math.sin(elapsed * 1.1) * 10, heroY - 10, 118, 92, 0.2, 124, 58, 237, 0.26 * nebEnv);
        drawSoftCloud(ctx, cx + 34 - Math.cos(elapsed * 0.95) * 10, heroY + 12, 112, 86, -0.25, 59, 130, 246, 0.22 * nebEnv);
        drawSoftCloud(ctx, cx, heroY - 2, 88, 76, 0, 139, 92, 246, 0.22 * nebEnv);
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

        // The live Island orb is the hero throughout this act.
      }
      // Act III (2.42s – 3.75s): Ascent + Dead-Center Circle Dock + Clean Resting Pill Handoff
      else {
        // The live shell is docked and unfurling beneath the particle field.
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
      window.removeEventListener("resize", onWinResize);
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
        zIndex: 1,
      }}
    />
  );
};
