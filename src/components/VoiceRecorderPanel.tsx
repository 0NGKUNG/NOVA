import React, { useRef, useState } from "react";
import { CheckCircle2, Copy, FileText, Mic, Square, Wand2 } from "lucide-react";
import { NovaSnapshot } from "../types";
import { Lang, t } from "../i18n";
import { novaApi } from "../lib/novaClient";

interface VoiceRecorderPanelProps {
  snapshot: NovaSnapshot;
  lang: Lang;
  compact?: boolean;
  onVoiceCommand?: (commandText: string) => void;
}

interface BrowserSpeechRecognition extends EventTarget {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  start(): void;
  stop(): void;
}

export const VoiceRecorderPanel: React.FC<VoiceRecorderPanelProps> = ({
  snapshot,
  lang,
  compact = false,
  onVoiceCommand,
}) => {
  const [recording, setRecording] = useState(false);
  const [busy, setBusy] = useState(false);
  const [autoPaste, setAutoPaste] = useState(true);
  const [voiceMode, setVoiceMode] = useState<"dictate" | "meeting" | "command">("dictate");
  const [speechLang, setSpeechLang] = useState<"th-TH" | "en-US">("th-TH");
  const [transcript, setTranscript] = useState("");
  const [noteTitle, setNoteTitle] = useState("");
  const [statusMsg, setStatusMsg] = useState<string | null>(null);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const startTimeRef = useRef<number>(0);
  const webSpeechRef = useRef<BrowserSpeechRecognition | null>(null);

  const sttProvider = snapshot.settings.sttProvider;

  const startCapture = async () => {
    setStatusMsg(null);
    startTimeRef.current = Date.now();

    // Check if Web Speech mode is selected or if no cloud STT key exists yet
    const hasCloudKey =
      (sttProvider === "groq" && snapshot.secrets.groq) ||
      (sttProvider === "gemini" && snapshot.secrets.gemini) ||
      (sttProvider === "openai" && snapshot.secrets.openai);

    const SpeechCtor =
      (window as unknown as { SpeechRecognition?: new () => BrowserSpeechRecognition }).SpeechRecognition ||
      (window as unknown as { webkitSpeechRecognition?: new () => BrowserSpeechRecognition }).webkitSpeechRecognition;

    if ((sttProvider === "webspeech" || !hasCloudKey) && SpeechCtor) {
      try {
        const rec = new SpeechCtor();
        rec.lang = speechLang;
        rec.continuous = true;
        rec.interimResults = true;
        rec.onresult = (ev) => {
          let combined = "";
          for (let i = 0; i < ev.results.length; i++) {
            combined += ev.results[i][0].transcript + " ";
          }
          setTranscript(combined.trim());
        };
        rec.onerror = (ev) => {
          setStatusMsg(`Speech notice: ${ev.error}`);
        };
        rec.start();
        webSpeechRef.current = rec;
        setRecording(true);
        return;
      } catch {
        // Fallback to MediaRecorder below
      }
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mr = new MediaRecorder(stream);
      chunksRef.current = [];
      mr.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      mr.onstop = async () => {
        stream.getTracks().forEach((tr) => tr.stop());
        const blob = new Blob(chunksRef.current, { type: "audio/webm" });
        setBusy(true);
        const res = await novaApi.transcribeAudioBlob(blob, voiceMode === "dictate" && autoPaste);
        setBusy(false);
        if (res.ok && res.text) {
          setTranscript(res.text);
          if (voiceMode === "command" && onVoiceCommand) {
            onVoiceCommand(res.text);
          }
          setStatusMsg(
            voiceMode === "dictate" && autoPaste
              ? "Transcribed & pasted into active window!"
              : "Transcription complete."
          );
        } else {
          setStatusMsg(res.error || "Configure a Groq/Gemini/OpenAI key or use Web Speech mode.");
        }
      };
      mr.start();
      mediaRecorderRef.current = mr;
      setRecording(true);
    } catch (err) {
      setStatusMsg(`Microphone error: ${String(err)}`);
    }
  };

  const stopCapture = async () => {
    setRecording(false);
    if (webSpeechRef.current) {
      webSpeechRef.current.stop();
      webSpeechRef.current = null;
      if (transcript.trim()) {
        setBusy(true);
        const res = await novaApi.processVoiceText(
          transcript,
          voiceMode === "dictate" && autoPaste
        );
        setBusy(false);
        if (res.ok) {
          setTranscript(res.text);
          if (voiceMode === "command" && onVoiceCommand) {
            onVoiceCommand(res.text);
          }
          setStatusMsg("Processed with NOVA Bilingual Tech Dictionary!");
        }
      }
      return;
    }

    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
      mediaRecorderRef.current.stop();
    }
  };

  const handleSaveMeetingNote = async () => {
    if (!transcript.trim()) return;
    setBusy(true);
    const dur = Math.max(5, Math.round((Date.now() - (startTimeRef.current || Date.now())) / 1000));
    const res = await novaApi.saveVoiceNote(
      noteTitle,
      voiceMode === "meeting" ? "meeting" : "memo",
      transcript,
      dur
    );
    setBusy(false);
    if (res.ok) {
      setStatusMsg("Saved summarized note + action items!");
      setNoteTitle("");
    }
  };

  return (
    <div className="nova-voice-panel">
      <div className="nova-row-between">
        <div className="nova-segmented">
          <button
            className={voiceMode === "dictate" ? "active" : ""}
            onClick={() => setVoiceMode("dictate")}
          >
            Dictate (TH/EN)
          </button>
          <button
            className={voiceMode === "meeting" ? "active" : ""}
            onClick={() => setVoiceMode("meeting")}
          >
            Meeting Note
          </button>
          <button
            className={voiceMode === "command" ? "active" : ""}
            onClick={() => setVoiceMode("command")}
          >
            Voice Command
          </button>
        </div>

        <div className="nova-segmented">
          <button
            className={speechLang === "th-TH" ? "active" : ""}
            onClick={() => setSpeechLang("th-TH")}
            title="Thai + English Technical Code-Switching"
          >
            🇹🇭 ไทย+EN
          </button>
          <button
            className={speechLang === "en-US" ? "active" : ""}
            onClick={() => setSpeechLang("en-US")}
          >
            🇺🇸 EN
          </button>
        </div>
      </div>

      <div className="nova-voice-controls">
        {!recording ? (
          <button className="nova-btn nova-btn-primary nova-mic-btn" onClick={startCapture} disabled={busy}>
            <Mic size={16} />
            <span>{busy ? "Processing..." : t(lang, "startDictation")}</span>
          </button>
        ) : (
          <button className="nova-btn nova-btn-deny nova-mic-btn pulse-recording" onClick={stopCapture}>
            <Square size={15} />
            <span>{t(lang, "stopDictation")}</span>
          </button>
        )}

        {voiceMode === "dictate" && (
          <label className="nova-checkbox-label">
            <input
              type="checkbox"
              checked={autoPaste}
              onChange={(e) => setAutoPaste(e.target.checked)}
            />
            <span>Auto-paste (`Ctrl+V`)</span>
          </label>
        )}
      </div>

      {voiceMode === "meeting" && !compact && (
        <input
          className="nova-input"
          placeholder="Meeting / Voice Memo Title (optional)..."
          value={noteTitle}
          onChange={(e) => setNoteTitle(e.target.value)}
        />
      )}

      <textarea
        className="nova-textarea"
        rows={compact ? 3 : 5}
        placeholder="Speak in Thai + English (e.g. 'ช่วยเช็ค แอนติกราวิตี้ กับ เทาริ') or paste/type transcript here..."
        value={transcript}
        onChange={(e) => setTranscript(e.target.value)}
      />

      <div className="nova-row-between">
        <div className="nova-btn-group">
          <button
            className="nova-btn nova-btn-ghost nova-btn-xs"
            disabled={!transcript.trim() || busy}
            onClick={async () => {
              const r = await novaApi.processVoiceText(transcript, false);
              if (r.ok) setTranscript(r.text);
            }}
          >
            <Wand2 size={13} />
            <span>Apply Tech Dict</span>
          </button>

          <button
            className="nova-btn nova-btn-ghost nova-btn-xs"
            disabled={!transcript.trim()}
            onClick={() => novaApi.copyToClipboard(transcript)}
          >
            <Copy size={13} />
            <span>Copy</span>
          </button>

          <button
            className="nova-btn nova-btn-rule nova-btn-xs"
            disabled={!transcript.trim() || busy}
            onClick={handleSaveMeetingNote}
          >
            <FileText size={13} />
            <span>Summarize & Save Note</span>
          </button>
        </div>

        {statusMsg && (
          <span className="nova-status-hint">
            <CheckCircle2 size={12} /> {statusMsg}
          </span>
        )}
      </div>
    </div>
  );
};
