// Procedural WebAudio Futuristic Chime Synthesizer (zero copyrighted audio files)
export type SoundCue =
  | "ready"
  | "step"
  | "approval_needed"
  | "approved"
  | "denied"
  | "focus_complete"
  | "island_open"
  | "island_close";

let audioCtx: AudioContext | null = null;

function ctx(): AudioContext | null {
  if (typeof window === "undefined") return null;
  if (!audioCtx) {
    const Ctor = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (Ctor) audioCtx = new Ctor();
  }
  if (audioCtx && audioCtx.state === "suspended") {
    audioCtx.resume().catch(() => {});
  }
  return audioCtx;
}

function tone(
  ac: AudioContext,
  freq: number,
  startOffset: number,
  duration: number,
  gainPeak: number,
  type: OscillatorType = "sine"
) {
  const osc = ac.createOscillator();
  const gain = ac.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, ac.currentTime + startOffset);

  gain.gain.setValueAtTime(0.0001, ac.currentTime + startOffset);
  gain.gain.exponentialRampToValueAtTime(gainPeak, ac.currentTime + startOffset + 0.018);
  gain.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + startOffset + duration);

  osc.connect(gain);
  gain.connect(ac.destination);
  osc.start(ac.currentTime + startOffset);
  osc.stop(ac.currentTime + startOffset + duration + 0.02);
}

export function playNovaCue(cue: SoundCue, enabled: boolean) {
  if (!enabled) return;
  const ac = ctx();
  if (!ac) return;

  switch (cue) {
    case "ready":
      tone(ac, 587.33, 0, 0.14, 0.06, "sine");
      tone(ac, 880.0, 0.07, 0.22, 0.07, "triangle");
      break;
    case "step":
      tone(ac, 740.0, 0, 0.08, 0.035, "sine");
      break;
    case "approval_needed":
      tone(ac, 523.25, 0, 0.13, 0.085, "triangle");
      tone(ac, 659.25, 0.09, 0.13, 0.085, "triangle");
      tone(ac, 1046.5, 0.18, 0.28, 0.095, "sine");
      break;
    case "approved":
      tone(ac, 659.25, 0, 0.1, 0.06, "sine");
      tone(ac, 987.77, 0.06, 0.18, 0.065, "sine");
      break;
    case "denied":
      tone(ac, 349.23, 0, 0.12, 0.065, "sawtooth");
      tone(ac, 261.63, 0.09, 0.2, 0.06, "triangle");
      break;
    case "focus_complete":
      tone(ac, 523.25, 0, 0.16, 0.07, "sine");
      tone(ac, 659.25, 0.1, 0.16, 0.07, "sine");
      tone(ac, 783.99, 0.2, 0.16, 0.07, "sine");
      tone(ac, 1046.5, 0.3, 0.35, 0.085, "triangle");
      break;
    case "island_open":
      tone(ac, 392.0, 0, 0.09, 0.022, "sine");
      tone(ac, 587.33, 0.035, 0.13, 0.026, "sine");
      break;
    case "island_close":
      tone(ac, 493.88, 0, 0.08, 0.02, "sine");
      tone(ac, 329.63, 0.03, 0.11, 0.018, "sine");
      break;
  }
}
