import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronDown,
  ChevronUp,
  CornerDownLeft,
  ExternalLink,
  HelpCircle,
  Loader2,
  Mic,
  Square,
  X,
} from "lucide-react";
import { PendingQuestion } from "../types";
import { Lang } from "../i18n";
import { novaApi } from "../lib/novaClient";

interface BrowserSpeechRecognition extends EventTarget {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  start(): void;
  stop(): void;
}

interface QuestionStepDraft {
  selectedIndices: number[];
  otherSelected: boolean;
  otherText: string;
}

interface QuestionCardProps {
  pending: PendingQuestion;
  lang: Lang;
  sttProvider?: "groq" | "gemini" | "openai" | "webspeech";
  hasCloudSttKey?: boolean;
  compact?: boolean;
}

export function formatQuestionDraftAnswer(
  options: string[],
  isMultiSelect: boolean,
  draft: QuestionStepDraft
): string {
  const picked = draft.selectedIndices
    .filter((i) => i >= 0 && i < options.length)
    .map((i) => options[i]);
  const custom = draft.otherText.trim();

  if (isMultiSelect) {
    const parts = [...picked];
    if (draft.otherSelected && custom) {
      parts.push(custom);
    }
    return parts.join("; ");
  }

  if (draft.otherSelected) {
    return custom;
  }
  return picked[0] ?? "";
}

export const QuestionCard: React.FC<QuestionCardProps> = ({
  pending,
  lang,
  sttProvider = "groq",
  hasCloudSttKey = false,
  compact = false,
}) => {
  const totalQuestions = Math.max(1, pending.questions.length);
  const [stepIdx, setStepIdx] = useState(0);
  const [collapsed, setCollapsed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);

  const [drafts, setDrafts] = useState<QuestionStepDraft[]>(() =>
    pending.questions.map((q) => ({
      selectedIndices: q.options.length > 0 && !q.isMultiSelect ? [0] : [],
      otherSelected: q.options.length === 0,
      otherText: "",
    }))
  );

  const otherInputRef = useRef<HTMLInputElement | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const webSpeechRef = useRef<BrowserSpeechRecognition | null>(null);

  useEffect(() => {
    setStepIdx(0);
    setCollapsed(false);
    setDrafts(
      pending.questions.map((q) => ({
        selectedIndices: q.options.length > 0 && !q.isMultiSelect ? [0] : [],
        otherSelected: q.options.length === 0,
        otherText: "",
      }))
    );
  }, [pending.id, pending.questions]);

  const safeIdx = Math.min(stepIdx, totalQuestions - 1);
  const currentQ = pending.questions[safeIdx] ?? {
    question: "Question",
    options: [],
    isMultiSelect: false,
  };
  const isMulti = Boolean(currentQ.isMultiSelect);
  const currentDraft = drafts[safeIdx] ?? {
    selectedIndices: [],
    otherSelected: false,
    otherText: "",
  };

  const updateCurrentDraft = useCallback(
    (updater: (prev: QuestionStepDraft) => QuestionStepDraft) => {
      setDrafts((prev) =>
        prev.map((d, idx) => (idx === safeIdx ? updater(d) : d))
      );
    },
    [safeIdx]
  );

  const selectOption = useCallback(
    (optIdx: number) => {
      updateCurrentDraft((prev) => {
        if (isMulti) {
          const exists = prev.selectedIndices.includes(optIdx);
          const nextIndices = exists
            ? prev.selectedIndices.filter((x) => x !== optIdx)
            : [...prev.selectedIndices, optIdx].sort((a, b) => a - b);
          return { ...prev, selectedIndices: nextIndices };
        }
        return {
          ...prev,
          selectedIndices: [optIdx],
          otherSelected: false,
        };
      });
    },
    [isMulti, updateCurrentDraft]
  );

  const selectOtherRow = useCallback(() => {
    updateCurrentDraft((prev) => {
      if (isMulti) {
        return { ...prev, otherSelected: !prev.otherSelected };
      }
      return {
        ...prev,
        selectedIndices: [],
        otherSelected: true,
      };
    });
    window.setTimeout(() => otherInputRef.current?.focus(), 10);
  }, [isMulti, updateCurrentDraft]);

  const currentStepValid = useMemo(() => {
    const ans = formatQuestionDraftAnswer(
      currentQ.options,
      isMulti,
      currentDraft
    );
    return ans.trim().length > 0;
  }, [currentDraft, currentQ.options, isMulti]);

  const submitAll = useCallback(
    async (opts?: { skipped?: boolean; passthroughToIde?: boolean }) => {
      if (busy) return;
      setBusy(true);
      try {
        const compiledAnswers = pending.questions.map((q, idx) => {
          const d = drafts[idx] ?? {
            selectedIndices: [],
            otherSelected: false,
            otherText: "",
          };
          return formatQuestionDraftAnswer(
            q.options,
            Boolean(q.isMultiSelect),
            d
          );
        });
        await novaApi.resolveQuestion({
          questionId: pending.id,
          answers: compiledAnswers,
          skipped: opts?.skipped,
          passthroughToIde: opts?.passthroughToIde,
        });
      } finally {
        setBusy(false);
      }
    },
    [busy, drafts, pending.id, pending.questions]
  );

  const handleContinue = useCallback(() => {
    if (busy) return;
    if (safeIdx + 1 < totalQuestions) {
      setStepIdx(safeIdx + 1);
      return;
    }
    void submitAll();
  }, [busy, safeIdx, submitAll, totalQuestions]);

  const handleSkipCurrentOrAll = useCallback(() => {
    if (busy) return;
    if (safeIdx + 1 < totalQuestions) {
      updateCurrentDraft(() => ({
        selectedIndices: [],
        otherSelected: false,
        otherText: "",
      }));
      setStepIdx(safeIdx + 1);
      return;
    }
    // Check if any earlier question had an answer; if none, mark full skip
    const anyPriorAnswered = drafts.some((d, idx) => {
      if (idx === safeIdx) return false;
      const q = pending.questions[idx];
      if (!q) return false;
      return formatQuestionDraftAnswer(q.options, Boolean(q.isMultiSelect), d).trim().length > 0;
    });
    if (anyPriorAnswered) {
      const nextDrafts = drafts.map((d, idx) =>
        idx === safeIdx
          ? { selectedIndices: [], otherSelected: false, otherText: "" }
          : d
      );
      setBusy(true);
      const compiledAnswers = pending.questions.map((q, idx) =>
        formatQuestionDraftAnswer(q.options, Boolean(q.isMultiSelect), nextDrafts[idx])
      );
      void novaApi
        .resolveQuestion({
          questionId: pending.id,
          answers: compiledAnswers,
          skipped: false,
        })
        .finally(() => setBusy(false));
    } else {
      void submitAll({ skipped: true });
    }
  }, [busy, drafts, pending.id, pending.questions, safeIdx, submitAll, totalQuestions, updateCurrentDraft]);

  const toggleVoiceDictation = async () => {
    if (recording) {
      setRecording(false);
      if (webSpeechRef.current) {
        webSpeechRef.current.stop();
        webSpeechRef.current = null;
        return;
      }
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
        mediaRecorderRef.current.stop();
      }
      return;
    }

    // Focus & select Other input for voice dictation
    updateCurrentDraft((prev) => ({
      ...prev,
      selectedIndices: isMulti ? prev.selectedIndices : [],
      otherSelected: true,
    }));
    otherInputRef.current?.focus();

    const SpeechCtor =
      (window as unknown as { SpeechRecognition?: new () => BrowserSpeechRecognition })
        .SpeechRecognition ||
      (window as unknown as { webkitSpeechRecognition?: new () => BrowserSpeechRecognition })
        .webkitSpeechRecognition;

    if ((sttProvider === "webspeech" || !hasCloudSttKey) && SpeechCtor) {
      try {
        const rec = new SpeechCtor();
        rec.lang = lang === "th" ? "th-TH" : "en-US";
        rec.continuous = false;
        rec.interimResults = true;
        rec.onresult = (ev) => {
          let combined = "";
          for (let i = 0; i < ev.results.length; i++) {
            combined += ev.results[i][0].transcript + " ";
          }
          const txt = combined.trim();
          updateCurrentDraft((prev) => ({
            ...prev,
            otherSelected: true,
            otherText: txt,
          }));
        };
        rec.onerror = () => setRecording(false);
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
        setTranscribing(true);
        try {
          const res = await novaApi.transcribeAudioBlob(blob, false);
          if (res.ok && res.text) {
            updateCurrentDraft((prev) => ({
              ...prev,
              selectedIndices: isMulti ? prev.selectedIndices : [],
              otherSelected: true,
              otherText: prev.otherText
                ? `${prev.otherText.trim()} ${res.text!.trim()}`
                : res.text!.trim(),
            }));
          }
        } finally {
          setTranscribing(false);
        }
      };
      mr.start();
      mediaRecorderRef.current = mr;
      setRecording(true);
    } catch {
      setRecording(false);
    }
  };

  // Keyboard navigation (`1`-`9`, `ArrowLeft`/`ArrowRight`, `Enter`) when not typing inside Other input
  const handleCardKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement | null;
    const inTextInput = Boolean(target?.closest("input, textarea"));

    if (e.key === "Enter" && !e.shiftKey) {
      if (currentStepValid) {
        e.preventDefault();
        e.stopPropagation();
        handleContinue();
      }
      return;
    }

    if (inTextInput) return;

    if (e.key === "ArrowLeft" && safeIdx > 0) {
      e.preventDefault();
      setStepIdx(safeIdx - 1);
      return;
    }
    if (e.key === "ArrowRight" && safeIdx + 1 < totalQuestions) {
      e.preventDefault();
      setStepIdx(safeIdx + 1);
      return;
    }

    const digit = Number(e.key);
    if (Number.isInteger(digit) && digit >= 1) {
      const optCount = currentQ.options.length;
      if (digit <= optCount) {
        e.preventDefault();
        selectOption(digit - 1);
      } else if (digit === optCount + 1) {
        e.preventDefault();
        selectOtherRow();
      }
    }
  };

  const otherBadgeNum = currentQ.options.length + 1;

  return (
    <div
      className={`nova-question-card ${collapsed ? "is-collapsed" : ""} ${
        compact ? "is-compact" : ""
      }`}
      tabIndex={0}
      onKeyDown={handleCardKeyDown}
    >
      {/* HEADER BAR: [? + blue dot + Question Title] ... [<- 1/2 -> | v | x] */}
      <div className="nova-qcard-header">
        <div
          className="nova-qcard-title-row"
          onClick={() => collapsed && setCollapsed(false)}
        >
          <span className="nova-qcard-icon-wrap" aria-hidden="true">
            <HelpCircle size={15} />
            <span className="nova-qcard-unread-dot" />
          </span>
          <span className="nova-qcard-question">{currentQ.question}</span>
          {isMulti && (
            <span className="nova-qcard-multi-chip">
              {lang === "th" ? "เลือกได้หลายข้อ" : "Select all that apply"}
            </span>
          )}
        </div>

        <div className="nova-qcard-controls">
          {totalQuestions > 1 && (
            <div className="nova-qcard-pager" aria-label="Question navigation">
              <button
                type="button"
                className="nova-qcard-nav-btn"
                disabled={safeIdx === 0 || busy}
                onClick={() => setStepIdx((i) => Math.max(0, i - 1))}
                title={lang === "th" ? "คำถามก่อนหน้า" : "Previous question"}
              >
                <ArrowLeft size={12.5} />
              </button>
              <span className="nova-qcard-step-count">
                {safeIdx + 1}/{totalQuestions}
              </span>
              <button
                type="button"
                className="nova-qcard-nav-btn"
                disabled={safeIdx + 1 >= totalQuestions || busy}
                onClick={() => setStepIdx((i) => Math.min(totalQuestions - 1, i + 1))}
                title={lang === "th" ? "คำถามถัดไป" : "Next question"}
              >
                <ArrowRight size={12.5} />
              </button>
            </div>
          )}

          <button
            type="button"
            className="nova-qcard-nav-btn"
            onClick={() => setCollapsed((v) => !v)}
            title={collapsed ? "Expand question" : "Collapse question"}
          >
            {collapsed ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
          </button>

          <button
            type="button"
            className="nova-qcard-nav-btn"
            disabled={busy}
            onClick={() => void submitAll({ skipped: true })}
            title={lang === "th" ? "ข้ามคำถามนี้" : "Dismiss / Skip"}
          >
            <X size={13.5} />
          </button>
        </div>
      </div>

      {!collapsed && (
        <>
          {/* NUMBERED OPTIONS LIST */}
          <div className="nova-qcard-options" role={isMulti ? "group" : "radiogroup"}>
            {currentQ.options.map((opt, idx) => {
              const selected = currentDraft.selectedIndices.includes(idx);
              return (
                <button
                  key={`${idx}-${opt}`}
                  type="button"
                  role={isMulti ? "checkbox" : "radio"}
                  aria-checked={selected}
                  disabled={busy}
                  className={`nova-qcard-option ${selected ? "is-selected" : ""}`}
                  onClick={() => selectOption(idx)}
                  onDoubleClick={() => {
                    if (!isMulti) {
                      selectOption(idx);
                      window.setTimeout(() => handleContinue(), 0);
                    }
                  }}
                >
                  <span className={`nova-qcard-num ${selected ? "is-selected" : ""}`}>
                    {isMulti && selected ? <Check size={11} strokeWidth={2.6} /> : idx + 1}
                  </span>
                  <span className="nova-qcard-option-text">{opt}</span>
                </button>
              );
            })}

            {/* FINAL ROW: N+1 Other (write your answer) + Mic + Skip + Continue */}
            <div
              className={`nova-qcard-other-row ${
                currentDraft.otherSelected ? "is-selected" : ""
              }`}
              onClick={() => {
                if (!currentDraft.otherSelected) selectOtherRow();
              }}
            >
              <button
                type="button"
                className={`nova-qcard-num ${
                  currentDraft.otherSelected ? "is-selected" : ""
                }`}
                onClick={(e) => {
                  e.stopPropagation();
                  selectOtherRow();
                }}
              >
                {isMulti && currentDraft.otherSelected ? (
                  <Check size={11} strokeWidth={2.6} />
                ) : (
                  otherBadgeNum
                )}
              </button>

              <input
                ref={otherInputRef}
                type="text"
                className="nova-qcard-other-input"
                disabled={busy}
                value={currentDraft.otherText}
                placeholder={
                  lang === "th"
                    ? "อื่นๆ (พิมพ์คำตอบของคุณ)"
                    : "Other (write your answer)"
                }
                onFocus={() => {
                  if (!currentDraft.otherSelected) {
                    updateCurrentDraft((prev) => ({
                      ...prev,
                      selectedIndices: isMulti ? prev.selectedIndices : [],
                      otherSelected: true,
                    }));
                  }
                }}
                onChange={(e) => {
                  const val = e.target.value;
                  updateCurrentDraft((prev) => ({
                    ...prev,
                    selectedIndices:
                      !isMulti && val.trim().length > 0 ? [] : prev.selectedIndices,
                    otherSelected: val.trim().length > 0 ? true : prev.otherSelected,
                    otherText: val,
                  }));
                }}
              />

              <div
                className="nova-qcard-footer-actions"
                onClick={(e) => e.stopPropagation()}
              >
                <button
                  type="button"
                  className="nova-qcard-ide-btn"
                  disabled={busy}
                  onClick={() => void submitAll({ passthroughToIde: true })}
                  title={
                    lang === "th"
                      ? "ส่งต่อไปตอบในหน้าต่าง Antigravity IDE"
                      : "Hand off to Antigravity IDE"
                  }
                >
                  <ExternalLink size={11} />
                  <span>IDE</span>
                </button>

                <button
                  type="button"
                  className={`nova-qcard-mic-btn ${recording ? "is-recording" : ""}`}
                  disabled={busy || transcribing}
                  onClick={() => void toggleVoiceDictation()}
                  title={
                    recording
                      ? lang === "th"
                        ? "หยุดบันทึกเสียง"
                        : "Stop dictation"
                      : lang === "th"
                        ? "พูดเพื่อพิมพ์คำตอบ"
                        : "Dictate custom answer"
                  }
                >
                  {transcribing ? (
                    <Loader2 size={13} className="spin-icon" />
                  ) : recording ? (
                    <Square size={11} />
                  ) : (
                    <Mic size={13.5} />
                  )}
                </button>

                <button
                  type="button"
                  className="nova-qcard-skip-btn"
                  disabled={busy}
                  onClick={handleSkipCurrentOrAll}
                >
                  {lang === "th" ? "ข้าม" : "Skip"}
                </button>

                <button
                  type="button"
                  className="nova-qcard-continue-btn"
                  disabled={busy || !currentStepValid}
                  onClick={handleContinue}
                >
                  <span>
                    {safeIdx + 1 < totalQuestions
                      ? lang === "th"
                        ? "ถัดไป"
                        : "Continue"
                      : lang === "th"
                        ? "ส่งคำตอบ"
                        : "Continue"}
                  </span>
                  <CornerDownLeft size={12} />
                </button>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
};
