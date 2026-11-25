/**
 * NOVA Island Physics Engine
 *
 * Mirrors Coucou / SwiftUI Dynamic Island motion architecture:
 * - Expanding / growing uses a sub-stepped harmonic spring (`ω₀ = 2π / response`, `ζ = damping`)
 *   for organic elasticity, micro-overshoot, and 100% mid-flight interruptibility at any refresh rate.
 * - Collapsing / shrinking uses a 340ms timed cubic-bezier(0.45, 0, 0.2, 1) curve with zero
 *   undershoot so the folded pill never pinches smaller than its resting capsule.
 */

export type EaseFn = (t: number) => number;

export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
export const clamp = (v: number, lo: number, hi: number): number =>
  Math.max(lo, Math.min(hi, v));

export function cubicBezier(x1: number, y1: number, x2: number, y2: number): EaseFn {
  const cx = (t: number) =>
    (1 - t) * (1 - t) * 3 * t * x1 + 3 * (1 - t) * t * t * x2 + t * t * t;
  const cy = (t: number) =>
    (1 - t) * (1 - t) * 3 * t * y1 + 3 * (1 - t) * t * t * y2 + t * t * t;

  return (x: number) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let lo = 0;
    let hi = 1;
    let t = x;
    for (let i = 0; i < 12; i++) {
      if (cx(t) < x) lo = t;
      else hi = t;
      t = (lo + hi) * 0.5;
    }
    return cy(t);
  };
}

/** Coucou signature 340ms zero-overshoot retraction curve */
export const closeCurve: EaseFn = cubicBezier(0.45, 0, 0.2, 1);

/** Smooth content reveal curve */
export const revealCurve: EaseFn = cubicBezier(0.22, 1, 0.36, 1);

export const ISLAND_CLOSE_MS = 340;
export const ISLAND_OPEN_RESPONSE = 0.46;
export const ISLAND_OPEN_DAMPING = 0.74;

/**
 * SwiftUI-equivalent damped harmonic oscillator integrated at 1/240s sub-steps
 * so frame drops or 60Hz/120Hz/240Hz displays never destabilize motion.
 */
export class Spring {
  value: number;
  target: number;
  velocity = 0;
  private omega: number;
  private zeta: number;

  constructor(
    initial: number,
    response = ISLAND_OPEN_RESPONSE,
    damping = ISLAND_OPEN_DAMPING
  ) {
    this.value = initial;
    this.target = initial;
    this.omega = (2 * Math.PI) / response;
    this.zeta = damping;
  }

  configure(response: number, damping: number): void {
    this.omega = (2 * Math.PI) / response;
    this.zeta = damping;
  }

  set(v: number): void {
    this.value = v;
    this.target = v;
    this.velocity = 0;
  }

  get settled(): boolean {
    return Math.abs(this.target - this.value) < 0.012 && Math.abs(this.velocity) < 0.06;
  }

  step(dtSeconds: number): void {
    const safeDt = clamp(dtSeconds, 0, 0.064);
    const steps = Math.max(1, Math.ceil(safeDt / (1 / 240)));
    const h = safeDt / steps;
    for (let i = 0; i < steps; i++) {
      const acc =
        this.omega * this.omega * (this.target - this.value) -
        2 * this.zeta * this.omega * this.velocity;
      this.velocity += acc * h;
      this.value += this.velocity * h;
    }
  }
}

/**
 * Hybrid tracked dimension:
 * - Grows via physics spring (elastic, velocity-preserving when re-targeted mid-flight)
 * - Shrinks via smooth cubic-bezier curve (clean landing, zero undershoot)
 */
export class TrackedValue {
  private spring: Spring;
  private curveFrom = 0;
  private curveTo = 0;
  private curveStartMs = 0;
  private curveDurMs = ISLAND_CLOSE_MS;
  private mode: "spring" | "curve" | "idle" = "idle";

  constructor(initial: number) {
    this.spring = new Spring(initial);
  }

  get value(): number {
    return this.spring.value;
  }

  get target(): number {
    return this.spring.target;
  }

  get velocity(): number {
    return this.spring.velocity;
  }

  get animating(): boolean {
    return this.mode !== "idle";
  }

  jump(v: number): void {
    this.spring.set(v);
    this.mode = "idle";
  }

  springTo(
    v: number,
    response = ISLAND_OPEN_RESPONSE,
    damping = ISLAND_OPEN_DAMPING
  ): void {
    if (Math.abs(this.spring.target - v) < 0.05 && this.mode === "spring") return;
    if (Math.abs(this.spring.value - v) < 0.05 && Math.abs(this.spring.velocity) < 0.1) {
      this.jump(v);
      return;
    }
    this.spring.configure(response, damping);
    this.spring.target = v;
    this.mode = "spring";
  }

  curveTowards(
    v: number,
    durationMs = ISLAND_CLOSE_MS,
    nowMs = performance.now()
  ): void {
    if (Math.abs(this.spring.target - v) < 0.05 && this.mode === "curve") return;
    if (Math.abs(this.spring.value - v) < 0.05) {
      this.jump(v);
      return;
    }
    this.curveFrom = this.spring.value;
    this.curveTo = v;
    this.curveStartMs = nowMs;
    this.curveDurMs = Math.max(16, durationMs);
    this.spring.target = v;
    this.spring.velocity = 0;
    this.mode = "curve";
  }

  /** Automatically chooses spring when growing and close-curve when shrinking. */
  morphTo(
    v: number,
    opts?: {
      forceSpring?: boolean;
      forceCurve?: boolean;
      response?: number;
      damping?: number;
      durationMs?: number;
      nowMs?: number;
    }
  ): void {
    if (opts?.forceCurve) {
      this.curveTowards(v, opts.durationMs ?? ISLAND_CLOSE_MS, opts.nowMs);
      return;
    }
    if (opts?.forceSpring || v >= this.spring.value) {
      this.springTo(
        v,
        opts?.response ?? ISLAND_OPEN_RESPONSE,
        opts?.damping ?? ISLAND_OPEN_DAMPING
      );
    } else {
      this.curveTowards(v, opts?.durationMs ?? ISLAND_CLOSE_MS, opts?.nowMs);
    }
  }

  step(dtSeconds: number, nowMs = performance.now()): void {
    if (this.mode === "spring") {
      this.spring.step(dtSeconds);
      if (this.spring.settled) {
        this.spring.set(this.spring.target);
        this.mode = "idle";
      }
    } else if (this.mode === "curve") {
      const p = clamp((nowMs - this.curveStartMs) / this.curveDurMs, 0, 1);
      this.spring.value = p >= 1 ? this.curveTo : lerp(this.curveFrom, this.curveTo, closeCurve(p));
      if (p >= 1) {
        this.spring.set(this.curveTo);
        this.mode = "idle";
      }
    }
  }
}

export function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}
