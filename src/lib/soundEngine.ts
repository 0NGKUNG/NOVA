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
    { freq: 392.0, start: 0, dur: 0.085, peak: 0.024, type: "sine" },
    { freq: 587.33, start: 0.028, dur: 0.12, peak: 0.028, type: "sine" },
  ],
  island_close: [
    { freq: 493.88, start: 0, dur: 0.075, peak: 0.022, type: "sine" },
    { freq: 329.63, start: 0.025, dur: 0.105, peak: 0.02, type: "sine" },
  ],
};

let audioCtx: AudioContext | null = null;
let cachedSampleRate = 0;
const bufferCache = new Map<SoundCue, AudioBuffer>();
let keepAliveSource: AudioBufferSourceNode | null = null;
let unlockListenersAttached = false;
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

function buildCueBuffer(ac: AudioContext, cue: SoundCue): AudioBuffer {
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
// using a -114 dBFS (2e-6 amplitude) 24 Hz AC loop — completely inaudible and zero DC offset.
function syncKeepAlive(ac: AudioContext, shouldKeepAlive: boolean) {
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
  const twoPi24 = (Math.PI * 2 * 24) / sr;
  for (let i = 0; i < frames; i++) {
    ch[i] = 2e-6 * Math.sin(i * twoPi24);
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
    if (audioCtx && audioCtx.state === "suspended") {
      audioCtx
        .resume()
        .then(() => {
          if (audioCtx) syncKeepAlive(audioCtx, true);
        })
        .catch(() => {});
    }
  };
  window.addEventListener("pointerdown", unlock, { passive: true });
  window.addEventListener("keydown", unlock, { passive: true });
}

function getOrCreateContext(): AudioContext | null {
  if (typeof window === "undefined") return null;
  if (!audioCtx) {
    const Ctor =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    audioCtx = new Ctor({ latencyHint: "interactive" });
    attachUnlockListeners();
  }
  ensureBuffers(audioCtx);
  return audioCtx;
}

export function warmNovaAudio(enabled: boolean) {
  if (!enabled) {
    if (audioCtx) syncKeepAlive(audioCtx, false);
    return;
  }
  const ac = getOrCreateContext();
  if (!ac) return;
  if (ac.state === "suspended") {
    ac.resume()
      .then(() => syncKeepAlive(ac, true))
      .catch(() => {});
  } else {
    syncKeepAlive(ac, true);
  }
}

function fireBuffer(ac: AudioContext, cue: SoundCue) {
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

  if (ac.state === "suspended") {
    const requestedAt = performance.now();
    const maxDelayMs = cue === "island_open" || cue === "island_close" ? 75 : 300;
    ac.resume()
      .then(() => {
        syncKeepAlive(ac, true);
        if (performance.now() - requestedAt <= maxDelayMs) {
          fireBuffer(ac, cue);
        }
      })
      .catch(() => {});
  }
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

    // Act I (0.00–0.86s): Deep horizon pipe-fifth inhale
    spaceWind(0.02, 0.74, 0.84, 0.095, 110, 1250, 2.2, 0.55);
    synthVoice({ freq: 65.41, endFreq: 130.81, start: 0.02, attack: 0.58, dur: 0.84, peak: 0.085, type: "sine", wet: 0.25 });
    synthVoice({ freq: 98.0, endFreq: 196.0, start: 0.08, attack: 0.52, dur: 0.78, peak: 0.05, type: "triangle", fStart: 250, fEnd: 900, wet: 0.45 });

    // Act II (0.86s): 36.71 Hz Tectonic Sub-Drop + Interstellar Pipe-Organ Drawbar Chord
    spaceWind(0.86, 0.02, 1.15, 0.12, 1600, 180, 1.2, 0.7);
    synthVoice({ freq: 138.0, endFreq: 36.71, start: 0.86, attack: 0.008, dur: 1.4, peak: 0.145, type: "sine", wet: 0 });

    const organStops: Array<{ f: number; p: number; pan: number; det: number; type: OscillatorType }> = [
      { f: 65.41, p: 0.065, pan: 0, det: 0, type: "sine" },
      { f: 130.81, p: 0.052, pan: -0.3, det: -4, type: "triangle" },
      { f: 196.0, p: 0.048, pan: 0.3, det: 4, type: "sine" },
      { f: 293.66, p: 0.042, pan: -0.38, det: -6, type: "sine" },
      { f: 329.63, p: 0.036, pan: 0.18, det: 3, type: "sine" },
      { f: 369.99, p: 0.04, pan: 0.38, det: 6, type: "triangle" },
      { f: 587.33, p: 0.028, pan: -0.2, det: -4, type: "sine" },
      { f: 739.99, p: 0.02, pan: 0.2, det: 5, type: "sine" },
    ];
    organStops.forEach((s) =>
      synthVoice({
        freq: s.f,
        start: 0.86,
        attack: 0.11,
        dur: 1.75,
        peak: s.p,
        type: s.type,
        detune: s.det,
        pan: s.pan,
        fStart: 600,
        fEnd: 2600,
        wet: 0.9,
      })
    );

    // 1.76s (^^ Smile): Celestial Cathedral Bell (E5 -> B5)
    synthVoice({ freq: 659.25, start: 1.76, attack: 0.008, dur: 0.38, peak: 0.04, type: "sine", pan: -0.25, fmRatio: 3, fmDepth: 22, wet: 0.92 });
    synthVoice({ freq: 987.77, start: 1.91, attack: 0.008, dur: 0.56, peak: 0.044, type: "sine", pan: 0.25, fmRatio: 3, fmDepth: 18, wet: 0.95 });

    // 2.90s (Capsule Dock): Deep Gravitational Airlock Seal
    synthVoice({ freq: 110, endFreq: 41.2, start: 2.9, attack: 0.005, dur: 0.14, peak: 0.075, type: "sine", wet: 0 });
    synthVoice({ freq: 493.88, endFreq: 587.33, start: 2.91, attack: 0.008, dur: 0.3, peak: 0.034, type: "sine", wet: 0.65 });

    const cleanup = () => {
      window.clearTimeout(timerId);
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
    const timerId = window.setTimeout(cleanup, 4800);
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
