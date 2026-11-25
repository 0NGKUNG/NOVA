// Zero-Latency Pre-Baked WebAudio Chime Engine + Pure 1B Interstellar Supernova Boot Synth
export type SoundCue =
  | "ready"
  | "step"
  | "approval_needed"
  | "approved"
  | "denied"
  | "focus_complete"
  | "island_open"
  | "island_close";

interface PartialNote {
  freq: number;
  start: number;
  dur: number;
  peak: number;
  type: "sine" | "triangle" | "sawtooth";
}

const CUE_RECIPES: Record<SoundCue, PartialNote[]> = {
  ready: [
    { freq: 587.33, start: 0, dur: 0.14, peak: 0.06, type: "sine" },
    { freq: 880.0, start: 0.07, dur: 0.22, peak: 0.07, type: "triangle" },
  ],
  step: [{ freq: 740.0, start: 0, dur: 0.08, peak: 0.035, type: "sine" }],
  approval_needed: [
    { freq: 523.25, start: 0, dur: 0.13, peak: 0.085, type: "triangle" },
    { freq: 659.25, start: 0.09, dur: 0.13, peak: 0.085, type: "triangle" },
    { freq: 1046.5, start: 0.18, dur: 0.28, peak: 0.095, type: "sine" },
  ],
  approved: [
    { freq: 659.25, start: 0, dur: 0.1, peak: 0.06, type: "sine" },
    { freq: 987.77, start: 0.06, dur: 0.18, peak: 0.065, type: "sine" },
  ],
  denied: [
    { freq: 349.23, start: 0, dur: 0.12, peak: 0.065, type: "sawtooth" },
    { freq: 261.63, start: 0.09, dur: 0.2, peak: 0.06, type: "triangle" },
  ],
  focus_complete: [
    { freq: 523.25, start: 0, dur: 0.16, peak: 0.07, type: "sine" },
    { freq: 659.25, start: 0.1, dur: 0.16, peak: 0.07, type: "sine" },
    { freq: 783.99, start: 0.2, dur: 0.16, peak: 0.07, type: "sine" },
    { freq: 1046.5, start: 0.3, dur: 0.35, peak: 0.085, type: "triangle" },
  ],
  island_open: [
    { freq: 392.0, start: 0, dur: 0.105, peak: 0.045, type: "sine" },
    { freq: 587.33, start: 0.026, dur: 0.14, peak: 0.05, type: "sine" },
  ],
  island_close: [
    { freq: 493.88, start: 0, dur: 0.095, peak: 0.042, type: "sine" },
    { freq: 329.63, start: 0.024, dur: 0.13, peak: 0.038, type: "sine" },
  ],
};

let audioCtx: AudioContext | null = null;
let cachedSampleRate = 0;
const bufferCache = new Map<SoundCue, AudioBuffer>();
const lastCueFiredAt = new Map<SoundCue, number>();
let keepAliveSource: AudioBufferSourceNode | null = null;
let unlockListenersAttached = false;
let shouldHoldKeepAlive = false;
let cachedCosmicNoise: AudioBuffer | null = null;
let activeBootCleanup: (() => void) | null = null;

function sampleWave(phase01: number, type: PartialNote["type"]): number {
  if (type === "sine") {
    return Math.sin(phase01 * Math.PI * 2);
  }
  if (type === "triangle") {
    return 1 - 4 * Math.abs(Math.round(phase01 - 0.25) - (phase01 - 0.25));
  }
  return 2 * (phase01 - Math.floor(phase01 + 0.5));
}

// Pre-bakes the softened 2.90s Capsule Dock stem from Pure 1D ("Event Horizon Velvet Dark")
// into a zero-latency 2-channel stereo AudioBuffer:
// - Expand (`island_open`): 46.25 -> 103.83 Hz velvet magnetic cushion + Eb4 -> Bb4 (311.13 -> 466.16 Hz) glide
// - Collapse (`island_close`): 103.83 -> 46.25 Hz airlock settle + Bb4 -> Eb4 (466.16 -> 311.13 Hz) reverse glide
function buildDockHoverBuffer(ac: AudioContext, direction: "open" | "close"): AudioBuffer {
  const sr = ac.sampleRate;
  const totalSec = direction === "open" ? 0.27 : 0.25;
  const len = Math.max(1, Math.ceil(totalSec * sr));
  const buf = ac.createBuffer(2, len, sr);
  const outL = buf.getChannelData(0);
  const outR = buf.getChannelData(1);
  const wetSend = new Float32Array(len);

  const addGlide = (opts: {
    f0: number;
    f1: number;
    start: number;
    attack: number;
    dur: number;
    peak: number;
    pan: number;
    wet: number;
  }) => {
    const { f0, f1, start, attack, dur, peak, pan, wet } = opts;
    const sIdx = Math.max(0, Math.floor(start * sr));
    const eIdx = Math.min(len, Math.ceil((start + dur) * sr));
    const decaySpan = Math.max(0.01, dur - attack);
    // Equal-power stereo panner gains
    const panAngle = ((pan + 1) * Math.PI) / 4;
    const gainL = Math.cos(panAngle);
    const gainR = Math.sin(panAngle);
    let phase = 0;

    for (let i = sIdx; i < eIdx; i++) {
      const t = (i - sIdx) / sr;
      const prog = t / dur;
      const freq = f0 * Math.pow(f1 / f0, prog);
      let env: number;
      if (t < attack) {
        env = peak * 0.5 * (1 - Math.cos(Math.PI * (t / attack)));
      } else {
        // Matches WebAudio exponentialRampToValueAtTime(0.0001) with soft velvet taper
        env = peak * Math.pow(0.0018, (t - attack) / decaySpan);
      }
      const rem = dur - t;
      if (rem < 0.008) {
        env *= Math.max(0, rem / 0.008);
      }
      const sample = Math.sin(phase * Math.PI * 2) * env;
      outL[i] += sample * gainL;
      outR[i] += sample * gainR;
      if (wet > 0) wetSend[i] += sample * wet;
      phase += freq / sr;
      if (phase >= 1) phase -= 1;
    }
  };

  if (direction === "open") {
    addGlide({
      f0: 46.25,
      f1: 103.83,
      start: 0,
      attack: 0.012,
      dur: 0.135,
      peak: 0.036,
      pan: 0,
      wet: 0,
    });
    addGlide({
      f0: 311.13,
      f1: 466.16,
      start: 0.008,
      attack: 0.016,
      dur: 0.215,
      peak: 0.021,
      pan: 0.08,
      wet: 0.11,
    });
  } else {
    addGlide({
      f0: 103.83,
      f1: 46.25,
      start: 0,
      attack: 0.01,
      dur: 0.125,
      peak: 0.034,
      pan: 0,
      wet: 0,
    });
    addGlide({
      f0: 466.16,
      f1: 311.13,
      start: 0.006,
      attack: 0.015,
      dur: 0.195,
      peak: 0.019,
      pan: -0.08,
      wet: 0.09,
    });
  }

  // One-pole 1650 Hz velvet low-pass + subtle 28ms(L)/41ms(R) micro-room (zero long echo)
  const rc = 1 / (2 * Math.PI * 1650);
  const dt = 1 / sr;
  const alpha = dt / (rc + dt);
  let lp = 0;
  for (let i = 0; i < len; i++) {
    lp += alpha * (wetSend[i] - lp);
    wetSend[i] = lp;
  }
  const delayL = Math.floor(0.028 * sr);
  const delayR = Math.floor(0.041 * sr);
  const endFadeSamples = Math.max(1, Math.floor(0.045 * sr));
  for (let i = 0; i < len; i++) {
    const tailFade = i > len - endFadeSamples ? (len - i) / endFadeSamples : 1;
    if (i >= delayL) outL[i] += wetSend[i - delayL] * tailFade;
    if (i >= delayR) outR[i] += wetSend[i - delayR] * tailFade;
    outL[i] *= tailFade;
    outR[i] *= tailFade;
  }

  return buf;
}

function buildCueBuffer(ac: AudioContext, cue: SoundCue): AudioBuffer {
  if (cue === "island_open") return buildDockHoverBuffer(ac, "open");
  if (cue === "island_close") return buildDockHoverBuffer(ac, "close");

  const notes = CUE_RECIPES[cue];
  const sr = ac.sampleRate;
  let totalSec = 0.05;
  for (const n of notes) {
    totalSec = Math.max(totalSec, n.start + n.dur + 0.008);
  }
  const len = Math.max(1, Math.ceil(totalSec * sr));
  const buf = ac.createBuffer(1, len, sr);
  const data = buf.getChannelData(0);

  const attackSec = 0.0035;
  const tailFadeSec = 0.003;

  for (const n of notes) {
    const startIdx = Math.max(0, Math.floor(n.start * sr));
    const endIdx = Math.min(len, Math.ceil((n.start + n.dur) * sr));
    const decaySpan = Math.max(0.005, n.dur - attackSec);
    let phase = 0;
    const phaseStep = n.freq / sr;

    for (let i = startIdx; i < endIdx; i++) {
      const t = (i - startIdx) / sr;
      let env: number;
      if (t < attackSec) {
        env = n.peak * 0.5 * (1 - Math.cos(Math.PI * (t / attackSec)));
      } else {
        env = n.peak * Math.pow(0.0012, (t - attackSec) / decaySpan);
      }
      const rem = n.dur - t;
      if (rem < tailFadeSec) {
        env *= Math.max(0, rem / tailFadeSec);
      }
      data[i] += sampleWave(phase, n.type) * env;
      phase += phaseStep;
      if (phase >= 1) phase -= 1;
    }
  }

  return buf;
}

function ensureBuffers(ac: AudioContext) {
  if (cachedSampleRate === ac.sampleRate && bufferCache.size === 8) return;
  bufferCache.clear();
  cachedSampleRate = ac.sampleRate;
  cachedCosmicNoise = null;
  (Object.keys(CUE_RECIPES) as SoundCue[]).forEach((cue) => {
    bufferCache.set(cue, buildCueBuffer(ac, cue));
  });
}

function getCosmicNoiseBuffer(ac: AudioContext): AudioBuffer {
  if (cachedCosmicNoise && cachedCosmicNoise.sampleRate === ac.sampleRate) {
    return cachedCosmicNoise;
  }
  const sr = ac.sampleRate;
  const buf = ac.createBuffer(1, Math.ceil(sr * 2.5), sr);
  const ch = buf.getChannelData(0);
  let b0 = 0;
  let b1 = 0;
  let b2 = 0;
  for (let i = 0; i < ch.length; i++) {
    const w = Math.random() * 2 - 1;
    b0 = 0.997 * b0 + w * 0.029;
    b1 = 0.985 * b1 + w * 0.032;
    b2 = 0.95 * b2 + w * 0.048;
    ch[i] = (b0 + b1 + b2 + w * 0.014) * 0.85;
  }
  cachedCosmicNoise = buf;
  return buf;
}

// Keeps Chromium's SilentSinkSuspender & Windows WASAPI / Bluetooth / USB DAC stream awake
// using a -87 dBFS (4.5e-5 amplitude = ~1.5 LSB in 16-bit PCM so WASAPI never quantizes it to 0x0000!)
// 19 Hz sub-audible AC loop — 100% physically inaudible and zero DC offset.
function syncKeepAlive(ac: AudioContext, shouldKeepAlive: boolean) {
  shouldHoldKeepAlive = shouldKeepAlive;
  if (!shouldKeepAlive) {
    if (keepAliveSource) {
      try {
        keepAliveSource.stop();
        keepAliveSource.disconnect();
      } catch {
        // ignore
      }
      keepAliveSource = null;
    }
    return;
  }

  if (keepAliveSource || ac.state !== "running") return;

  const sr = ac.sampleRate;
  const frames = sr;
  const kaBuf = ac.createBuffer(1, frames, sr);
  const ch = kaBuf.getChannelData(0);
  const twoPi19 = (Math.PI * 2 * 19) / sr;
  for (let i = 0; i < frames; i++) {
    ch[i] = 4.5e-5 * Math.sin(i * twoPi19);
  }

  const src = ac.createBufferSource();
  src.buffer = kaBuf;
  src.loop = true;
  src.connect(ac.destination);
  src.start();
  keepAliveSource = src;
}

function attachUnlockListeners() {
  if (unlockListenersAttached || typeof window === "undefined") return;
  unlockListenersAttached = true;
  const unlock = () => {
    if (audioCtx && audioCtx.state !== "running" && audioCtx.state !== "closed") {
      audioCtx
        .resume()
        .then(() => {
          if (audioCtx && shouldHoldKeepAlive) syncKeepAlive(audioCtx, true);
        })
        .catch(() => {});
    }
  };
  window.addEventListener("pointerdown", unlock, { passive: true });
  window.addEventListener("pointermove", unlock, { passive: true });
  window.addEventListener("keydown", unlock, { passive: true });
}

function getOrCreateContext(): AudioContext | null {
  if (typeof window === "undefined") return null;
  if (!audioCtx || audioCtx.state === "closed") {
    const Ctor =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    keepAliveSource = null;
    audioCtx = new Ctor({ latencyHint: "interactive" });
    audioCtx.onstatechange = () => {
      if (!audioCtx) return;
      if (audioCtx.state === "running" && shouldHoldKeepAlive) {
        syncKeepAlive(audioCtx, true);
      } else if (
        shouldHoldKeepAlive &&
        (audioCtx.state === "suspended" || (audioCtx.state as string) === "interrupted")
      ) {
        audioCtx.resume().catch(() => {});
      }
    };
    attachUnlockListeners();
  }
  ensureBuffers(audioCtx);
  return audioCtx;
}

export function warmNovaAudio(enabled: boolean) {
  if (!enabled) {
    shouldHoldKeepAlive = false;
    if (audioCtx) syncKeepAlive(audioCtx, false);
    return;
  }
  shouldHoldKeepAlive = true;
  const ac = getOrCreateContext();
  if (!ac) return;
  if (ac.state !== "running") {
    ac.resume()
      .then(() => syncKeepAlive(ac, true))
      .catch(() => {});
  } else {
    syncKeepAlive(ac, true);
  }
}

function fireBuffer(ac: AudioContext, cue: SoundCue) {
  const nowMs = performance.now();
  const prevMs = lastCueFiredAt.get(cue) ?? -1000;
  if (nowMs - prevMs < 42) return;
  lastCueFiredAt.set(cue, nowMs);

  const buf = bufferCache.get(cue) ?? buildCueBuffer(ac, cue);
  const src = ac.createBufferSource();
  src.buffer = buf;
  src.connect(ac.destination);
  src.start();
}

export function playNovaCue(cue: SoundCue, enabled: boolean) {
  if (!enabled) return;
  const ac = getOrCreateContext();
  if (!ac) return;

  if (ac.state === "running") {
    syncKeepAlive(ac, true);
    fireBuffer(ac, cue);
    return;
  }

  const requestedAt = performance.now();
  const maxDelayMs = cue === "island_open" || cue === "island_close" ? 260 : 400;
  ac.resume()
    .then(() => {
      syncKeepAlive(ac, true);
      if (performance.now() - requestedAt <= maxDelayMs) {
        fireBuffer(ac, cue);
      }
    })
    .catch(() => {});
}

/**
 * NOVA Signature Boot Soundtrack — Pure 1B ("Event Horizon: Interstellar Organ & Sub")
 * Synced frame-accurately to Supernova Ignition:
 * - 0.00s: Deep horizon pipe-fifth inhale (C2 + G2 rising into C3/G3)
 * - 0.86s: 36.71 Hz tectonic sub-drop + C-Lydian cathedral pipe-organ drawbars
 * - 1.76s: Celestial bell harmonic (E5 -> B5) on NOVA's (^^) greeting smile
 * - 2.90s: Deep gravitational airlock dock seal
 * Self-disposes its temporary stereo reverb graph after 4.6s so 0% idle DSP remains.
 */
export function playSupernovaBootAudio(enabled: boolean) {
  if (!enabled) return;
  const ac = getOrCreateContext();
  if (!ac) return;

  const schedule = () => {
    syncKeepAlive(ac, true);
    activeBootCleanup?.();

    const master = ac.createGain();
    master.gain.value = 0.9;
    master.connect(ac.destination);

    const dryBus = ac.createGain();
    dryBus.gain.value = 1.0;
    dryBus.connect(master);

    // Temporary 3-tap stereo ping-pong space reverb hall (disconnected cleanly after tail finishes)
    const spaceBus = ac.createGain();
    spaceBus.gain.value = 0.52;

    const preLp = ac.createBiquadFilter();
    preLp.type = "lowpass";
    preLp.frequency.value = 2600;

    const dL = ac.createDelay(1.2);
    const dR = ac.createDelay(1.2);
    const dC = ac.createDelay(1.2);
    dL.delayTime.value = 0.17;
    dR.delayTime.value = 0.26;
    dC.delayTime.value = 0.37;

    const fbL = ac.createGain();
    const fbR = ac.createGain();
    const fbC = ac.createGain();
    fbL.gain.value = 0.44;
    fbR.gain.value = 0.44;
    fbC.gain.value = 0.34;

    const merger = ac.createChannelMerger(2);
    spaceBus.connect(preLp);
    preLp.connect(dL);
    preLp.connect(dR);
    preLp.connect(dC);

    dL.connect(fbL);
    fbL.connect(dR);
    dR.connect(fbR);
    fbR.connect(dL);
    dC.connect(fbC);
    fbC.connect(preLp);

    dL.connect(merger, 0, 0);
    dR.connect(merger, 0, 1);
    dC.connect(merger, 0, 0);
    dC.connect(merger, 0, 1);
    merger.connect(master);

    const disposableNodes: AudioNode[] = [
      master,
      dryBus,
      spaceBus,
      preLp,
      dL,
      dR,
      dC,
      fbL,
      fbR,
      fbC,
      merger,
    ];
    const stoppableSources: AudioScheduledSourceNode[] = [];

    const synthVoice = (opts: {
      freq: number;
      endFreq?: number;
      start: number;
      attack?: number;
      dur: number;
      peak: number;
      type?: OscillatorType;
      detune?: number;
      pan?: number;
      fStart?: number;
      fEnd?: number;
      q?: number;
      wet?: number;
      fmRatio?: number;
      fmDepth?: number;
    }) => {
      const {
        freq,
        endFreq = freq,
        start,
        attack = 0.02,
        dur,
        peak,
        type = "sine",
        detune = 0,
        pan = 0,
        fStart = 0,
        fEnd = 0,
        q = 1.4,
        wet = 0.4,
        fmRatio = 0,
        fmDepth = 0,
      } = opts;
      const t0 = ac.currentTime + start;
      const osc = ac.createOscillator();
      osc.type = type;
      osc.detune.value = detune;
      osc.frequency.setValueAtTime(Math.max(18, freq), t0);
      if (endFreq !== freq) {
        osc.frequency.exponentialRampToValueAtTime(Math.max(18, endFreq), t0 + dur);
      }

      if (fmRatio > 0 && fmDepth > 0) {
        const mod = ac.createOscillator();
        const modGain = ac.createGain();
        mod.type = "sine";
        mod.frequency.setValueAtTime(freq * fmRatio, t0);
        modGain.gain.setValueAtTime(fmDepth, t0);
        modGain.gain.exponentialRampToValueAtTime(0.4, t0 + dur);
        mod.connect(modGain);
        modGain.connect(osc.frequency);
        mod.start(t0);
        mod.stop(t0 + dur + 0.04);
        stoppableSources.push(mod);
        disposableNodes.push(mod, modGain);
      }

      const g = ac.createGain();
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.linearRampToValueAtTime(peak, t0 + attack);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);

      let last: AudioNode = osc;
      if (fStart > 0) {
        const flt = ac.createBiquadFilter();
        flt.type = "lowpass";
        flt.Q.value = q;
        flt.frequency.setValueAtTime(fStart, t0);
        if (fEnd > 0 && fEnd !== fStart) {
          flt.frequency.exponentialRampToValueAtTime(fEnd, t0 + dur * 0.78);
        }
        last.connect(flt);
        last = flt;
        disposableNodes.push(flt);
      }

      if (pan !== 0 && typeof ac.createStereoPanner === "function") {
        const sp = ac.createStereoPanner();
        sp.pan.value = pan;
        last.connect(sp);
        last = sp;
        disposableNodes.push(sp);
      }

      last.connect(g);
      g.connect(dryBus);

      if (wet > 0) {
        const ws = ac.createGain();
        ws.gain.value = wet;
        g.connect(ws);
        ws.connect(spaceBus);
        disposableNodes.push(ws);
      }

      osc.start(t0);
      osc.stop(t0 + dur + 0.04);
      stoppableSources.push(osc);
      disposableNodes.push(osc, g);
    };

    const spaceWind = (
      start: number,
      attack: number,
      dur: number,
      peak: number,
      bpStart: number,
      bpEnd: number,
      q: number,
      wet: number
    ) => {
      const t0 = ac.currentTime + start;
      const src = ac.createBufferSource();
      src.buffer = getCosmicNoiseBuffer(ac);
      const bp = ac.createBiquadFilter();
      bp.type = "bandpass";
      bp.Q.value = q;
      bp.frequency.setValueAtTime(bpStart, t0);
      bp.frequency.exponentialRampToValueAtTime(bpEnd, t0 + dur);

      const g = ac.createGain();
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.linearRampToValueAtTime(peak, t0 + attack);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);

      src.connect(bp);
      bp.connect(g);
      g.connect(dryBus);
      if (wet > 0) {
        const ws = ac.createGain();
        ws.gain.value = wet;
        g.connect(ws);
        ws.connect(spaceBus);
        disposableNodes.push(ws);
      }
      src.start(t0);
      src.stop(t0 + dur + 0.04);
      stoppableSources.push(src);
      disposableNodes.push(src, bp, g);
    };

    // Act I (0.00–0.86s): Deep dark-matter velvet inhale (low-passed < 950Hz — zero bright hiss)
    spaceWind(0.03, 0.72, 0.83, 0.085, 110, 880, 2.2, 0.45);
    synthVoice({ freq: 51.91, endFreq: 103.83, start: 0.04, attack: 0.56, dur: 0.82, peak: 0.082, type: "sine", wet: 0.15 });
    synthVoice({ freq: 233.08, endFreq: 293.66, start: 0.24, attack: 0.48, dur: 0.62, peak: 0.026, type: "sine", wet: 0.75 });

    // Act II (0.86s): Buttery 38.89 Hz Sub Cushion + Warm Ab-Lydian Silk Pad (Ab2, Eb3, Bb3, D4, F4)
    spaceWind(0.86, 0.025, 1.0, 0.095, 1150, 175, 1.4, 0.55);
    synthVoice({ freq: 116.54, endFreq: 38.89, start: 0.86, attack: 0.01, dur: 1.25, peak: 0.135, type: "sine", wet: 0 });

    const velvetPad: Array<{ f: number; p: number; pan: number; det: number; type: OscillatorType }> = [
      { f: 103.83, p: 0.052, pan: -0.34, det: -7, type: "sawtooth" },
      { f: 155.56, p: 0.048, pan: 0.34, det: 7, type: "sawtooth" },
      { f: 233.08, p: 0.044, pan: -0.22, det: -5, type: "triangle" },
      { f: 293.66, p: 0.04, pan: 0.22, det: 5, type: "sine" },
      { f: 349.23, p: 0.03, pan: 0, det: 0, type: "sine" },
    ];
    velvetPad.forEach((v) =>
      synthVoice({
        freq: v.f,
        start: 0.86,
        attack: 0.085,
        dur: 1.62,
        peak: v.p,
        type: v.type,
        detune: v.det,
        pan: v.pan,
        fStart: 280,
        fEnd: 1350,
        q: 1.5,
        wet: 0.78,
      })
    );

    // 1.76s (^^ Smile): Intimate Warm Frosted-Glass Harmonic (Bb4 -> F5)
    synthVoice({ freq: 466.16, start: 1.76, attack: 0.008, dur: 0.34, peak: 0.042, type: "sine", pan: -0.2, fmRatio: 2, fmDepth: 16, wet: 0.82 });
    synthVoice({ freq: 698.46, start: 1.9, attack: 0.008, dur: 0.48, peak: 0.045, type: "sine", pan: 0.2, fmRatio: 2, fmDepth: 14, wet: 0.88 });

    // 2.90s (Capsule Dock): Cushioned Magnetic Settle (Eb4 -> Bb4)
    synthVoice({ freq: 103.83, endFreq: 46.25, start: 2.9, attack: 0.005, dur: 0.12, peak: 0.06, type: "sine", wet: 0 });
    synthVoice({ freq: 311.13, endFreq: 466.16, start: 2.91, attack: 0.008, dur: 0.26, peak: 0.035, type: "sine", wet: 0.5 });

    let disposed = false;
    const dispose = () => {
      if (disposed) return;
      disposed = true;
      window.clearTimeout(fadeTimerId);
      window.clearTimeout(disposeTimerId);
      if (activeBootCleanup === cleanup) activeBootCleanup = null;
      stoppableSources.forEach((s) => {
        try {
          s.stop();
        } catch {
          // ignore already stopped
        }
      });
      disposableNodes.forEach((n) => {
        try {
          n.disconnect();
        } catch {
          // ignore
        }
      });
    };
    // Graceful 120ms fade-out (no click) used for interruptions
    const cleanup = () => {
      if (disposed) return;
      window.clearTimeout(fadeTimerId);
      window.clearTimeout(disposeTimerId);
      try {
        const now = ac.currentTime;
        master.gain.cancelScheduledValues(now);
        master.gain.setValueAtTime(master.gain.value, now);
        master.gain.linearRampToValueAtTime(0.0001, now + 0.12);
      } catch {
        // ignore
      }
      window.setTimeout(dispose, 150);
    };
    // The final dock chime ends ~3.2s; echo/reverb feedback rings out until ~5.2s.
    // Fade the master gently from 5.6s and release the whole graph at 6.4s.
    const fadeTimerId = window.setTimeout(() => {
      try {
        const now = ac.currentTime;
        master.gain.cancelScheduledValues(now);
        master.gain.setValueAtTime(master.gain.value, now);
        master.gain.linearRampToValueAtTime(0.0001, now + 0.7);
      } catch {
        // ignore
      }
    }, 5600);
    const disposeTimerId = window.setTimeout(dispose, 6400);
    activeBootCleanup = cleanup;
  };

  if (ac.state === "running") {
    schedule();
  } else if (ac.state === "suspended") {
    ac.resume()
      .then(() => schedule())
      .catch(() => {});
  }
}

export function stopSupernovaBootAudio() {
  activeBootCleanup?.();
}
