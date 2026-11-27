import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Camera, Check, ChevronDown, Cpu, FolderOpen, Gauge, ImagePlus, Plus, RefreshCw, Send, Square, X } from "lucide-react";
import { AGY_CLI_MODELS, AgentSession, AgyQuotaSnapshot, NovaSnapshot, PermissionMode } from "../types";
import { Lang } from "../i18n";
import { novaApi } from "../lib/novaClient";
import {
  computePopoverPlacement,
  ISLAND_HOVER_REGION_EVENT,
  notifyIslandPopoverSelect,
} from "../lib/islandHover";

const MAX_IMAGES = 8;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const IMAGE_EXT_RE = /\.(png|jpe?g|webp|gif|bmp)$/i;
const FAST_DEFAULT_CARBON_MODEL = "gemini-4-carbon-low";
const AGY_QUOTA_STALE_MS = 120_000;
const AGY_EFFORTS = ["low", "medium", "high", "xhigh"] as const;

let cachedAgyQuota: { data: AgyQuotaSnapshot; fetchedAt: number } | null = null;

function useCloseWhenIslandFolds(open: boolean, close: () => void) {
  const closeRef = useRef(close);
  useEffect(() => { closeRef.current = close; }, [close]);
  useEffect(() => {
    if (!open) return;
    const shell = document.querySelector<HTMLElement>(".nova-island-shell");
    if (!shell) return;
    const observer = new MutationObserver(() => {
      if (!shell.classList.contains("is-expanded")) closeRef.current();
    });
    observer.observe(shell, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, [open]);
}

function useUpdateIslandPopoverHitRegion(
  open: boolean,
  position: unknown,
  menuRef: React.RefObject<HTMLElement | null>
) {
  useLayoutEffect(() => {
    if (!open || !position) return;
    const notify = () => window.dispatchEvent(new Event(ISLAND_HOVER_REGION_EVENT));
    notify();
    const el = menuRef.current;
    const ro =
      el && typeof ResizeObserver !== "undefined" ? new ResizeObserver(notify) : null;
    if (el && ro) ro.observe(el);
    return () => {
      ro?.disconnect();
      notify();
    };
  }, [open, position, menuRef]);
}

const AGY_MODEL_FAMILIES = (() => {
  const families = new Map<string, { id: string; name: string; shortName: string; variants: Array<{ id: string; effort: string; label: string; hint: string }> }>();
  const familyMeta: Record<string, { name: string; shortName: string }> = {
    "gemini-4-carbon": { name: "Gemini 4 Carbon", shortName: "4 Carbon" },
    "gemini-3.8-flash": { name: "Gemini 3.8 Flash", shortName: "3.8 Flash" },
    "gemini-4-argon": { name: "Gemini 4 Argon", shortName: "4 Argon" },
    "gemini-4-hydrogen": { name: "Gemini 4 Hydrogen", shortName: "4 Hydrogen" },
    "gemini-4-neon": { name: "Gemini 4 Neon", shortName: "4 Neon" },
    "claude-sonnet-5-5": { name: "Claude Sonnet 5.5", shortName: "Sonnet 5.5" },
    "claude-opus-5-5": { name: "Claude Opus 5.5", shortName: "Opus 5.5" },
    "gpt-oss-120b": { name: "GPT-OSS 120B", shortName: "GPT-OSS 120B" },
  };
  for (const option of AGY_CLI_MODELS) {
    const match = option.id.match(/^(.*)-(low|medium|high|xhigh)$/);
    const id = match?.[1] ?? option.id;
    const effort = match?.[2] ?? "medium";
    const fallbackName = option.label.replace(/\s*\([^)]*\)$/, "");
    const meta = familyMeta[id] ?? { name: fallbackName, shortName: fallbackName };
    const family = families.get(id) ?? {
      id,
      name: meta.name,
      shortName: meta.shortName,
      variants: [],
    };
    family.variants.push({ id: option.id, effort, label: option.label, hint: option.hint });
    families.set(id, family);
  }
  return Array.from(families.values()).map((family) => ({
    ...family,
    variants: family.variants.sort((a, b) => AGY_EFFORTS.indexOf(a.effort as typeof AGY_EFFORTS[number]) - AGY_EFFORTS.indexOf(b.effort as typeof AGY_EFFORTS[number])),
  }));
})();

function formatEffortShort(effort: string): string {
  if (effort === "low") return "Low";
  if (effort === "medium") return "Med";
  if (effort === "high") return "High";
  if (effort === "xhigh") return "XHigh";
  return effort;
}

function formatCompactTriggerLabel(modelId: string): string | null {
  for (const family of AGY_MODEL_FAMILIES) {
    const variant = family.variants.find((v) => v.id === modelId);
    if (variant) {
      return family.variants.length > 1
        ? `${family.shortName} · ${formatEffortShort(variant.effort)}`
        : family.shortName;
    }
  }
  const raw = AGY_CLI_MODELS.find((m) => m.id === modelId);
  return raw ? raw.label : null;
}

function formatSessionModelBadge(rawModel: string): string {
  const cleaned = rawModel.trim();
  const known = formatCompactTriggerLabel(cleaned);
  if (known) return known;
  return cleaned
    .replace(/^gemini-/i, "")
    .replace(/^claude-/i, "")
    .slice(0, 20);
}

function getQuotaTone(remainingPct: number): "ok" | "warn" | "low" {
  if (remainingPct < 20) return "low";
  if (remainingPct < 50) return "warn";
  return "ok";
}

function formatResetCountdown(resetIso?: string): { short: string; full: string } | null {
  if (!resetIso) return null;
  const resetAt = Date.parse(resetIso);
  if (!Number.isFinite(resetAt) || resetAt <= Date.UTC(2000, 0, 1)) return null;
  const full = `Resets ${new Date(resetAt).toLocaleString()}`;
  const diffSec = Math.max(0, Math.round((resetAt - Date.now()) / 1000));
  if (diffSec <= 30) return { short: "now", full };
  const mins = Math.floor(diffSec / 60);
  if (mins < 60) return { short: `${mins}m`, full };
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  if (hours < 24) return { short: remMins > 0 ? `${hours}h ${remMins}m` : `${hours}h`, full };
  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  return { short: remHours > 0 ? `${days}d ${remHours}h` : `${days}d`, full };
}

function formatFetchedAge(fetchedAt: number, lang: Lang): string {
  if (!fetchedAt) return "";
  const sec = Math.max(0, Math.floor((Date.now() - fetchedAt) / 1000));
  if (sec < 15) return lang === "th" ? "เมื่อสักครู่" : "Just now";
  if (sec < 60) return `${sec}s ago`;
  const mins = Math.floor(sec / 60);
  return `${mins}m ago`;
}

interface AgyModelPickerProps {
  value: string;
  onChange: (modelId: string) => void;
  lang: Lang;
  defaultOptionLabel: string;
  triggerFallbackLabel: string;
  onOpen?: () => void;
}

const AgyModelPicker: React.FC<AgyModelPickerProps> = ({
  value,
  onChange,
  lang,
  defaultOptionLabel,
  triggerFallbackLabel,
  onOpen,
}) => {
  const [menuOpen, setMenuOpen] = useState(false);
  const [activeView, setActiveView] = useState<"models" | "usage">("models");
  const [quota, setQuota] = useState<AgyQuotaSnapshot | null>(() => cachedAgyQuota?.data ?? null);
  const [quotaFetchedAt, setQuotaFetchedAt] = useState<number>(() => cachedAgyQuota?.fetchedAt ?? 0);
  const [quotaLoading, setQuotaLoading] = useState(false);
  const [quotaError, setQuotaError] = useState<string | null>(null);
  const [menuPosition, setMenuPosition] = useState<{ top: number; left: number; dropDown: boolean } | null>(null);
  const [bodyMaxHeight, setBodyMaxHeight] = useState<number>(160);

  const pickerRef = useRef<HTMLDivElement | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  useCloseWhenIslandFolds(menuOpen, () => setMenuOpen(false));
  useUpdateIslandPopoverHitRegion(menuOpen, menuPosition, menuRef);

  const selectedModel = useMemo(
    () => AGY_CLI_MODELS.find((item) => item.id === value) ?? null,
    [value]
  );

  const triggerText = useMemo(
    () => (value ? formatCompactTriggerLabel(value) ?? triggerFallbackLabel : triggerFallbackLabel),
    [value, triggerFallbackLabel]
  );

  const lowestRemaining = useMemo(() => {
    if (!quota?.groups?.length) return null;
    let minVal: number | null = null;
    for (const g of quota.groups) {
      for (const b of g.buckets) {
        if (typeof b.remaining_fraction === "number") {
          const pct = Math.max(0, Math.min(100, Math.round(b.remaining_fraction * 100)));
          if (minVal === null || pct < minVal) minVal = pct;
        }
      }
    }
    return minVal;
  }, [quota]);

  const refreshQuota = useCallback(async () => {
    setQuotaLoading(true);
    setQuotaError(null);
    try {
      const result = await novaApi.refreshAgyQuota();
      if (result.ok && result.quota) {
        const now = Date.now();
        cachedAgyQuota = { data: result.quota, fetchedAt: now };
        setQuota(result.quota);
        setQuotaFetchedAt(now);
      } else {
        setQuotaError(result.error || (lang === "th" ? "อ่านโควตา AGY ไม่ได้" : "Could not read AGY usage."));
      }
    } catch {
      setQuotaError(lang === "th" ? "เชื่อมต่อ AGY ไม่ได้" : "Failed to query AGY usage.");
    } finally {
      setQuotaLoading(false);
    }
  }, [lang]);

  // Portal menus out of the island's clipped shell, opening above whenever space allows
  // and dropping below only when space above is too compact.
  useLayoutEffect(() => {
    if (!menuOpen) {
      setMenuPosition(null);
      return;
    }
    if (!pickerRef.current) return;
    const trigger = pickerRef.current.querySelector<HTMLElement>(".agy-model-trigger");
    const rect = trigger?.getBoundingClientRect();
    if (!rect) return;
    const menu = menuRef.current;
    const body = bodyRef.current;
    const chromeHeight = menu ? Math.max(36, menu.offsetHeight - (body?.offsetHeight ?? 0)) : 42;
    const rawBodyScroll = body?.scrollHeight ?? 0;
    const desiredBodyHeight = Math.min(260, rawBodyScroll || 220);
    const desiredHeight = chromeHeight + desiredBodyHeight;
    const menuWidth = menu?.offsetWidth || 306;
    const placement = computePopoverPlacement({
      triggerRect: rect,
      desiredHeight,
      menuWidth,
      viewportW: window.innerWidth,
      viewportH: window.innerHeight,
      gap: 6,
      margin: 8,
    });
    const bodyHeight = Math.max(40, Math.min(260, Math.floor(placement.availableHeight - chromeHeight)));
    setBodyMaxHeight((prev) => (prev === bodyHeight ? prev : bodyHeight));
    const actualBodyHeight = Math.min(rawBodyScroll || bodyHeight, bodyHeight);
    const panelHeight = chromeHeight + actualBodyHeight;
    const top = placement.dropDown
      ? rect.bottom + 6
      : Math.max(8, rect.top - panelHeight - 6);
    setMenuPosition((prev) =>
      prev &&
      prev.top === top &&
      prev.left === placement.left &&
      prev.dropDown === placement.dropDown
        ? prev
        : { top, left: placement.left, dropDown: placement.dropDown }
    );
  }, [menuOpen, activeView, quota, quotaLoading, quotaError]);

  // Scroll selected model row into view when opening Models tab
  useLayoutEffect(() => {
    if (!menuOpen || activeView !== "models" || !bodyRef.current) return;
    const activeEl = bodyRef.current.querySelector<HTMLElement>(".agy-compact-row.is-selected");
    activeEl?.scrollIntoView({ block: "nearest" });
  }, [menuOpen, activeView]);

  useEffect(() => {
    if (!menuOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!pickerRef.current?.contains(event.target as Node) && !menuRef.current?.contains(event.target as Node)) {
        setMenuOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        setMenuOpen(false);
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [menuOpen]);

  const openUsageTab = () => {
    setActiveView("usage");
    if (!quotaLoading && (!cachedAgyQuota || Date.now() - cachedAgyQuota.fetchedAt > AGY_QUOTA_STALE_MS)) {
      void refreshQuota();
    } else if (cachedAgyQuota && !quota) {
      setQuota(cachedAgyQuota.data);
      setQuotaFetchedAt(cachedAgyQuota.fetchedAt);
    }
  };

  return (
    <div className="agy-model-picker" ref={pickerRef}>
      <button
        type="button"
        className={`agy-model-trigger ${menuOpen ? "is-open" : ""} ${value ? "has-selection" : ""}`}
        aria-haspopup="dialog"
        aria-expanded={menuOpen}
        title={selectedModel ? `${selectedModel.label} — ${selectedModel.hint}` : (lang === "th" ? "เลือกรุ่นโมเดลและดูโควตา AGY" : "Choose AGY model & view usage")}
        onClick={() => {
          setMenuOpen((prev) => {
            const next = !prev;
            if (next) {
              onOpen?.();
              if (cachedAgyQuota) {
                setQuota(cachedAgyQuota.data);
                setQuotaFetchedAt(cachedAgyQuota.fetchedAt);
              }
            }
            return next;
          });
        }}
      >
        <Cpu size={12} />
        <span>{triggerText}</span>
        {lowestRemaining !== null && lowestRemaining < 35 && (
          <i className={`agy-trigger-quota-dot tone-${getQuotaTone(lowestRemaining)}`} title={`${lowestRemaining}% quota remaining`} />
        )}
        <ChevronDown className={`agy-trigger-chev ${menuOpen ? "is-open" : ""}`} size={11} />
      </button>

      {menuOpen && createPortal(
        <div
          ref={menuRef}
          className="agy-model-menu is-portaled"
          data-nova-island-hover-region={menuPosition ? "true" : undefined}
          style={{ top: `${menuPosition?.top ?? -10000}px`, left: `${menuPosition?.left ?? 8}px`, visibility: menuPosition ? "visible" : "hidden" }}
          role="dialog"
          aria-label={lang === "th" ? "เลือกโมเดลและดูโควตา AGY" : "AGY model & usage"}
        >
          <div className="agy-pop-header">
            <div className="agy-pop-tabs" role="tablist">
              <button
                type="button"
                role="tab"
                aria-selected={activeView === "models"}
                className={`agy-pop-tab ${activeView === "models" ? "is-active" : ""}`}
                onClick={() => setActiveView("models")}
              >
                <Cpu size={11} />
                <span>{lang === "th" ? "โมเดล" : "Models"}</span>
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={activeView === "usage"}
                className={`agy-pop-tab ${activeView === "usage" ? "is-active" : ""}`}
                onClick={openUsageTab}
              >
                <Gauge size={11} />
                <span>{lang === "th" ? "โควตา" : "Usage"}</span>
                {lowestRemaining !== null && (
                  <b className={`agy-pop-tab-pct tone-${getQuotaTone(lowestRemaining)}`}>{lowestRemaining}%</b>
                )}
              </button>
            </div>

            {activeView === "usage" ? (
              <div className="agy-pop-meta">
                {quotaFetchedAt > 0 && !quotaLoading && (
                  <span className="agy-pop-age">{formatFetchedAge(quotaFetchedAt, lang)}</span>
                )}
                <button
                  type="button"
                  className={`agy-pop-refresh ${quotaLoading ? "spinning" : ""}`}
                  aria-label={lang === "th" ? "รีเฟรชโควตา" : "Refresh usage"}
                  title={lang === "th" ? "รีเฟรชโควตา" : "Refresh usage"}
                  disabled={quotaLoading}
                  onClick={() => void refreshQuota()}
                >
                  <RefreshCw size={11} />
                </button>
              </div>
            ) : (
              <span className="agy-pop-hint">
                {selectedModel ? selectedModel.hint : (lang === "th" ? "คลิกเลือกความละเอียด" : "Pick model & effort")}
              </span>
            )}
          </div>

          <div
            ref={bodyRef}
            className="agy-pop-body"
            style={{ maxHeight: `${bodyMaxHeight}px` }}
          >
            {activeView === "models" ? (
              <div className="agy-compact-list" role="menu" aria-label="Models">
                <div className={`agy-compact-row is-default ${!value ? "is-selected" : ""}`}>
                  <button
                    type="button"
                    role="menuitemradio"
                    aria-checked={!value}
                    className="agy-compact-row-main"
                    onClick={(e) => {
                      notifyIslandPopoverSelect(e);
                      onChange("");
                      setMenuOpen(false);
                    }}
                  >
                    <span className={`agy-row-check ${!value ? "is-on" : ""}`}>
                      {!value ? <Check size={11} /> : <span className="agy-row-dot" />}
                    </span>
                    <span className="agy-row-name">{defaultOptionLabel}</span>
                  </button>
                  <span className="agy-effort-auto">{lang === "th" ? "อัตโนมัติ" : "Auto"}</span>
                </div>

                {AGY_MODEL_FAMILIES.map((family) => {
                  const activeVariant = family.variants.find((v) => v.id === value);
                  const hasActive = Boolean(activeVariant);
                  const preferredVariant =
                    activeVariant ??
                    (family.id === "gemini-4-carbon"
                      ? family.variants.find((v) => v.id === FAST_DEFAULT_CARBON_MODEL)
                      : family.variants.find((v) => v.effort === "medium")) ??
                    family.variants[0];

                  return (
                    <div
                      key={family.id}
                      className={`agy-compact-row ${hasActive ? "is-selected" : ""}`}
                    >
                      <button
                        type="button"
                        className="agy-compact-row-main"
                        title={preferredVariant ? `${family.name} — ${preferredVariant.hint}` : family.name}
                        onClick={(e) => {
                          notifyIslandPopoverSelect(e);
                          if (preferredVariant) onChange(preferredVariant.id);
                          setMenuOpen(false);
                        }}
                      >
                        <span className={`agy-row-check ${hasActive ? "is-on" : ""}`}>
                          {hasActive ? <Check size={11} /> : <span className="agy-row-dot" />}
                        </span>
                        <span className="agy-row-name">{family.name}</span>
                      </button>

                      <div className="agy-effort-pills" role="group" aria-label={`${family.name} thinking effort`}>
                        {family.variants.map((variant) => {
                          const isSelected = value === variant.id;
                          const effortLabel = formatEffortShort(variant.effort);
                          return (
                            <button
                              key={variant.id}
                              type="button"
                              role="menuitemradio"
                              aria-checked={isSelected}
                              className={`agy-effort-chip ${isSelected ? "is-selected" : ""}`}
                              title={`${family.name} (${effortLabel}) — ${variant.hint}`}
                              onClick={(e) => {
                                e.stopPropagation();
                                notifyIslandPopoverSelect(e);
                                onChange(variant.id);
                                setMenuOpen(false);
                              }}
                            >
                              {effortLabel}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="agy-usage-panel" role="status">
                {quotaLoading && !quota && (
                  <div className="agy-usage-state">
                    <RefreshCw size={12} className="spinning" />
                    <span>{lang === "th" ? "กำลังตรวจสอบโควตา…" : "Checking current usage…"}</span>
                  </div>
                )}

                {quotaError && (
                  <div className="agy-usage-state is-error">
                    <span>{quotaError}</span>
                    <button type="button" className="agy-usage-retry" onClick={() => void refreshQuota()}>
                      {lang === "th" ? "ลองใหม่" : "Retry"}
                    </button>
                  </div>
                )}

                {quota && quota.groups.length === 0 && !quotaLoading && (
                  <div className="agy-usage-state">
                    <span>{lang === "th" ? "ไม่พบข้อมูลโควตา" : "No quota buckets reported."}</span>
                  </div>
                )}

                {quota?.groups.map((group) => {
                  const showGroupHeader =
                    group.buckets.length > 0 &&
                    (quota.groups.length > 1 || group.buckets[0]?.name !== group.name);
                  return (
                    <section className="agy-quota-group" key={group.name}>
                      {showGroupHeader && <div className="agy-quota-group-title">{group.name}</div>}
                      {group.buckets.map((bucket) => {
                        const remaining = Math.max(0, Math.min(100, Math.round((bucket.remaining_fraction ?? 0) * 100)));
                        const tone = getQuotaTone(remaining);
                        const resetInfo = formatResetCountdown(bucket.reset_time);
                        return (
                          <div className="agy-quota-card" key={bucket.id} title={resetInfo?.full || bucket.description || bucket.name}>
                            <div className="agy-quota-row">
                              <span className="agy-quota-name">
                                {bucket.name}
                                {bucket.window && <em>{bucket.window}</em>}
                              </span>
                              <span className="agy-quota-stats">
                                {resetInfo && <small>↻ {resetInfo.short}</small>}
                                <b className={`tone-${tone}`}>{remaining}%</b>
                              </span>
                            </div>
                            <div className="agy-quota-track">
                              <span className={`tone-${tone}`} style={{ width: `${remaining}%` }} />
                            </div>
                          </div>
                        );
                      })}
                    </section>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      , document.body)}
    </div>
  );
};

export interface AttachedImageItem {
  id: string;
  dataUrl: string;
  name: string;
}

export function isSupportedImageFile(file: File): boolean {
  return file.type.startsWith("image/") || IMAGE_EXT_RE.test(file.name || "");
}

export function fileToDataUrl(file: File): Promise<string | null> {
  if (!isSupportedImageFile(file) || file.size <= 0 || file.size > MAX_IMAGE_BYTES) {
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : null);
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(file);
  });
}

async function filesToAttachedImages(files: Iterable<File>): Promise<AttachedImageItem[]> {
  const out: AttachedImageItem[] = [];
  let idx = 0;
  for (const f of files) {
    if (out.length >= MAX_IMAGES) break;
    const dataUrl = await fileToDataUrl(f);
    if (dataUrl) {
      idx += 1;
      const fallbackExt = f.type.split("/")[1]?.replace("jpeg", "jpg") || "png";
      out.push({
        id: `img-${Date.now()}-${idx}-${Math.random().toString(36).slice(2, 7)}`,
        dataUrl,
        name: f.name?.trim() || `pasted-${idx}.${fallbackExt}`,
      });
    }
  }
  return out;
}

function autoResizeTextarea(el: HTMLTextAreaElement | null) {
  if (!el) return;
  el.style.height = "auto";
  el.style.height = `${Math.min(112, Math.max(30, el.scrollHeight))}px`;
}

function autoResizeNewRunTextarea(el: HTMLTextAreaElement | null) {
  if (!el) return;
  el.style.height = "auto";
  el.style.height = `${Math.min(112, Math.max(24, el.scrollHeight))}px`;
}

function extractImageFilesFromClipboard(dt: DataTransfer | null): File[] {
  if (!dt) return [];
  const collected: File[] = [];
  if (dt.items && dt.items.length > 0) {
    for (let i = 0; i < dt.items.length; i += 1) {
      const item = dt.items[i];
      if (item.kind === "file") {
        const f = item.getAsFile();
        if (f && isSupportedImageFile(f)) collected.push(f);
      }
    }
  }
  if (collected.length === 0 && dt.files && dt.files.length > 0) {
    for (let i = 0; i < dt.files.length; i += 1) {
      const f = dt.files[i];
      if (isSupportedImageFile(f)) collected.push(f);
    }
  }
  return collected;
}

const AttachmentStrip: React.FC<{
  images: AttachedImageItem[];
  onRemove: (id: string) => void;
}> = ({ images, onRemove }) => {
  if (images.length === 0) return null;
  return (
    <div className="cockpit-attachments">
      {images.map((img) => (
        <div key={img.id} className="cockpit-thumb-card" title={img.name}>
          <img src={img.dataUrl} alt={img.name} className="cockpit-thumb-img" />
          <span className="cockpit-thumb-name">{img.name}</span>
          <button
            type="button"
            className="cockpit-thumb-remove"
            onClick={() => onRemove(img.id)}
            title="Remove image"
          >
            <X size={11} />
          </button>
        </div>
      ))}
    </div>
  );
};

export const PERMISSION_OPTIONS: Array<{ id: PermissionMode; label: string; hint: string }> = [
  { id: "follow_agy", label: "Follow AGY", hint: "Antigravity decides (Turbo / Auto / Default). No extra popups." },
  { id: "turbo", label: "Turbo", hint: "Allow everything without asking." },
  { id: "smart_auto", label: "Smart", hint: "Auto-allow safe commands, ask for risky ones." },
  { id: "request_review", label: "Review", hint: "Ask in NOVA for every command." },
];

export const PermissionPill: React.FC<{ snapshot: NovaSnapshot; session?: AgentSession | null }> = ({
  snapshot,
  session,
}) => {
  const global = (snapshot.settings.permissionMode ?? "follow_agy") as PermissionMode;
  const current = ((session?.permissionOverride as PermissionMode | null) || global) as PermissionMode;
  const ide = session?.detectedIdePermission || snapshot.detectedIdePermission;
  const [open, setOpen] = useState(false);
  const [menuPosition, setMenuPosition] = useState<{ top: number; left: number; dropDown: boolean; maxHeight: number } | null>(null);
  const pickerRef = useRef<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const currentOption = PERMISSION_OPTIONS.find((o) => o.id === current) ?? PERMISSION_OPTIONS[0];
  useCloseWhenIslandFolds(open, () => setOpen(false));
  useUpdateIslandPopoverHitRegion(open, menuPosition, menuRef);

  useLayoutEffect(() => {
    if (!open) {
      setMenuPosition(null);
      return;
    }
    if (!pickerRef.current) return;
    const rect = pickerRef.current.getBoundingClientRect();
    const rawHeight = menuRef.current?.scrollHeight ?? 176;
    const desiredHeight = Math.min(220, rawHeight);
    const menuWidth = menuRef.current?.offsetWidth || 254;
    const placement = computePopoverPlacement({
      triggerRect: rect,
      desiredHeight,
      menuWidth,
      viewportW: window.innerWidth,
      viewportH: window.innerHeight,
      gap: 7,
      margin: 8,
    });
    setMenuPosition({
      top: placement.top,
      left: placement.left,
      dropDown: placement.dropDown,
      maxHeight: Math.max(72, Math.min(220, placement.availableHeight)),
    });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!pickerRef.current?.contains(event.target as Node) && !menuRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div className="perm-pill" ref={pickerRef}>
      <button
        type="button"
        className={`perm-trigger ${open ? "is-open" : ""}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={currentOption.hint}
        onClick={() => setOpen((value) => !value)}
      >
        <span>{currentOption.label}</span>
        <ChevronDown size={11} />
      </button>
      {open && createPortal(
        <div
          ref={menuRef}
          className="perm-menu is-portaled"
          data-nova-island-hover-region={menuPosition ? "true" : undefined}
          style={{ top: `${menuPosition?.top ?? -10000}px`, left: `${menuPosition?.left ?? 8}px`, maxHeight: menuPosition ? `${menuPosition.maxHeight}px` : undefined, visibility: menuPosition ? "visible" : "hidden" }}
          role="listbox"
          aria-label="Permission mode"
        >
          {PERMISSION_OPTIONS.map((option) => (
            <button
              key={option.id}
              type="button"
              role="option"
              aria-selected={current === option.id}
              className={`perm-menu-option ${current === option.id ? "is-selected" : ""}`}
              title={option.hint}
              onClick={(e) => {
                notifyIslandPopoverSelect(e);
                void novaApi.setPermissionMode({
                  globalMode: option.id,
                  conversationId: session?.conversationId,
                  sessionOverride: session ? "" : undefined,
                });
                setOpen(false);
              }}
            >
              <span className="perm-option-copy">
                <span>{option.label}</span>
                <small>{option.hint}</small>
              </span>
              <span className="perm-option-check">{current === option.id ? <Check size={12} /> : null}</span>
            </button>
          ))}
        </div>,
        document.body,
      )}
      {current === "follow_agy" && ide && <span className="perm-ide">IDE: {ide}</span>}
    </div>
  );
};

interface CockpitProps {
  snapshot: NovaSnapshot;
  session: AgentSession | null;
  lang: Lang;
  compact?: boolean;
}

/** Unified bottom bar: Reply (idle) / Steer (running) / Stop + Image Paste/Upload/Snip. */
export const SessionCockpit: React.FC<CockpitProps> = ({ snapshot, session, lang, compact = false }) => {
  const [text, setText] = useState("");
  const [images, setImages] = useState<AttachedImageItem[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [attachmentMenuOpen, setAttachmentMenuOpen] = useState(false);
  const [attachmentMenuPosition, setAttachmentMenuPosition] = useState<{ top: number; left: number } | null>(null);
  const [mode, setMode] = useState<"auto" | "accept-edits" | "plan">("auto");
  const [model, setModel] = useState<string>("");
  const [notice, setNotice] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const attachWrapRef = useRef<HTMLDivElement | null>(null);
  const attachmentMenuRef = useRef<HTMLDivElement | null>(null);
  useCloseWhenIslandFolds(attachmentMenuOpen, () => setAttachmentMenuOpen(false));
  useUpdateIslandPopoverHitRegion(attachmentMenuOpen, attachmentMenuPosition, attachmentMenuRef);

  useEffect(() => {
    setModel("");
  }, [session?.conversationId]);

  useEffect(() => {
    if (!attachmentMenuOpen) return;
    const closeOnOutside = (e: PointerEvent) => {
      if (!attachWrapRef.current?.contains(e.target as Node) && !attachmentMenuRef.current?.contains(e.target as Node)) setAttachmentMenuOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutside);
    return () => document.removeEventListener("pointerdown", closeOnOutside);
  }, [attachmentMenuOpen]);

  useLayoutEffect(() => {
    if (!attachmentMenuOpen) {
      setAttachmentMenuPosition(null);
      return;
    }
    if (!attachWrapRef.current) return;
    const button = attachWrapRef.current.querySelector<HTMLElement>(".nova-composer-add");
    const rect = button?.getBoundingClientRect();
    if (!rect) return;
    const height = attachmentMenuRef.current?.scrollHeight ?? 76;
    const menuWidth = attachmentMenuRef.current?.offsetWidth || 205;
    const placement = computePopoverPlacement({
      triggerRect: rect,
      desiredHeight: height,
      menuWidth,
      viewportW: window.innerWidth,
      viewportH: window.innerHeight,
      gap: 9,
      margin: 8,
    });
    setAttachmentMenuPosition({ top: placement.top, left: placement.left });
  }, [attachmentMenuOpen]);

  const running = Boolean(session && (session.status === "active" || session.status === "waiting_approval"));
  const queued = session?.queuedMessages?.length ?? 0;
  const cliOk = snapshot.agyCliAvailable !== false;

  const appendImages = (incoming: AttachedImageItem[]) => {
    if (incoming.length === 0) return;
    setImages((prev) => [...prev, ...incoming].slice(0, MAX_IMAGES));
  };

  const handlePaste = async (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const pastedFiles = extractImageFilesFromClipboard(e.clipboardData);
    if (pastedFiles.length > 0) {
      e.preventDefault();
      const loaded = await filesToAttachedImages(pastedFiles);
      appendImages(loaded);
      return;
    }

    const plain = e.clipboardData?.getData("text/plain") ?? "";
    if (!plain) {
      e.preventDefault();
      const cb = await novaApi.readClipboardImage();
      if (cb.ok && cb.dataUrl) {
        appendImages([
          {
            id: `cb-${Date.now()}`,
            dataUrl: cb.dataUrl,
            name: cb.name || "clipboard.png",
          },
        ]);
      }
    }
  };

  const send = async () => {
    if (!text.trim() && images.length === 0) return;
    const res = await novaApi.sendSessionPrompt({
      workspacePath: session?.workspacePath,
      conversationId:
        session && (running || !session.conversationId.startsWith("pending-"))
          ? session.conversationId
          : undefined,
      prompt: text.replace(/\r\n?/g, "\n").replace(/^\n+|\s+$/g, ""),
      mode,
      model: model || null,
      imageDataUrl: images[0]?.dataUrl ?? null,
      images: images.map((img) => ({ dataUrl: img.dataUrl, name: img.name })),
    });
    if (res.ok) {
      setText("");
      if (inputRef.current) inputRef.current.style.height = compact ? "24px" : "30px";
      setImages([]);
      setNotice(res.delivery === "queued_hook" ? (lang === "th" ? "ส่งเข้า run ปัจจุบันแล้ว" : "Queued into live run") : null);
      inputRef.current?.focus();
    } else {
      setNotice(res.error ?? "Failed");
    }
  };

  return (
    <div
      className={`cockpit nova-session-agent-cockpit ${compact ? "is-compact" : ""} ${dragOver ? "is-dragover" : ""}`}
      onDragOver={(e) => {
        if (e.dataTransfer?.types?.includes("Files")) {
          e.preventDefault();
          e.stopPropagation();
          setDragOver(true);
        }
      }}
      onDragLeave={(e) => {
        e.stopPropagation();
        setDragOver(false);
      }}
      onDrop={async (e) => {
        e.preventDefault();
        e.stopPropagation();
        setDragOver(false);
        if (e.dataTransfer?.files?.length) {
          const loaded = await filesToAttachedImages(Array.from(e.dataTransfer.files));
          appendImages(loaded);
        }
      }}
    >
      {notice && <div className="ide-note-small">{notice}</div>}
      {queued > 0 && <div className="ide-note-small">{queued} queued…</div>}
      <AttachmentStrip
        images={images}
        onRemove={(id) => setImages((prev) => prev.filter((item) => item.id !== id))}
      />
      <input
        ref={fileInputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif,image/bmp,image/*"
        multiple
        hidden
        onChange={async (e) => {
          const list = e.target.files ? Array.from(e.target.files) : [];
          e.target.value = "";
          if (list.length > 0) {
            const loaded = await filesToAttachedImages(list);
            appendImages(loaded);
          }
        }}
      />
      <div className="nova-agent-composer">
        <div className="nova-composer-input-row">
        <textarea
          ref={inputRef}
          rows={1}
          className="nova-textarea cockpit-input"
          value={text}
          disabled={!cliOk && !running}
          placeholder={compact ? (lang === "th" ? "ส่งข้อความถึง Agent…" : "Message your agent…") : running
            ? lang === "th" ? "สั่งเพิ่ม / Ctrl+V วางรูป… (Shift+Enter ขึ้นบรรทัดใหม่)" : "Steer running agent or Ctrl+V paste image… (Shift+Enter new line)"
            : lang === "th" ? "ตอบ / สั่งงานต่อ / Ctrl+V วางรูป…" : "Reply, continue, or Ctrl+V paste image…"}
          onChange={(e) => {
            setText(e.target.value);
            if (compact) autoResizeNewRunTextarea(e.currentTarget);
            else autoResizeTextarea(e.currentTarget);
          }}
          onPaste={(e) => void handlePaste(e)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
        />
        </div>
        <div className="nova-composer-toolbar">
          <div className="nova-composer-tools-left">
        <div className="nova-composer-add-wrap" ref={attachWrapRef}>
          <button
            type="button"
            className={`nova-composer-add ${images.length > 0 ? "has-attachments" : ""}`}
            aria-label={lang === "th" ? "เพิ่มไฟล์แนบ" : "Add attachment"}
            aria-expanded={attachmentMenuOpen}
            title={lang === "th" ? "เพิ่มไฟล์แนบ" : "Add attachment"}
            onClick={() => setAttachmentMenuOpen((open) => !open)}
          >
            <Plus size={17} />
            {images.length > 0 && <span>{images.length}</span>}
          </button>
          {attachmentMenuOpen && createPortal(
            <div
              ref={attachmentMenuRef}
              className="nova-composer-menu is-portaled"
              data-nova-island-hover-region={attachmentMenuPosition ? "true" : undefined}
              style={{ top: `${attachmentMenuPosition?.top ?? -10000}px`, left: `${attachmentMenuPosition?.left ?? 8}px`, visibility: attachmentMenuPosition ? "visible" : "hidden" }}
              role="menu"
            >
              <button type="button" role="menuitem" onClick={(e) => { notifyIslandPopoverSelect(e); setAttachmentMenuOpen(false); fileInputRef.current?.click(); }}>
                <ImagePlus size={15} /><span>{lang === "th" ? "แนบรูปภาพ" : "Attach image"}</span><kbd>Ctrl V</kbd>
              </button>
              <button type="button" role="menuitem" onClick={async (e) => {
                notifyIslandPopoverSelect(e);
                setAttachmentMenuOpen(false);
                const r = await novaApi.captureScreenSnip();
                if (r.ok && r.dataUrl) appendImages([{ id: `snip-${Date.now()}`, dataUrl: r.dataUrl, name: `screen-${new Date().toTimeString().slice(0, 8).replace(/:/g, "")}.png` }]);
              }}>
                <Camera size={15} /><span>{lang === "th" ? "จับภาพหน้าจอ" : "Capture screen"}</span>
              </button>
            </div>,
            document.body,
          )}
        </div>
        {!running && (
          <AgyModelPicker
            value={model}
            onChange={setModel}
            lang={lang}
            defaultOptionLabel={lang === "th" ? "โมเดลปัจจุบัน" : "Current model"}
            triggerFallbackLabel={
              session?.modelName
                ? formatSessionModelBadge(session.modelName)
                : lang === "th"
                ? "โมเดลปัจจุบัน"
                : "Current"
            }
            onOpen={() => setAttachmentMenuOpen(false)}
          />
        )}
        {!compact && !running && (
          <select className="perm-select cockpit-mode-select" value={mode} onChange={(e) => setMode(e.target.value as typeof mode)}>
            <option value="auto">Auto</option>
            <option value="accept-edits">Accept edits</option>
            <option value="plan">Plan</option>
          </select>
        )}
          </div>
          <div className="nova-composer-tools-right">
            {compact && !running && <PermissionPill snapshot={snapshot} session={session} />}
        <div className="nova-composer-actions">
          <button type="button" className="nova-composer-send" disabled={(!cliOk && !running) || (!text.trim() && images.length === 0)} onClick={() => void send()} title={lang === "th" ? "ส่งข้อความ" : "Send message"}>
            <Send size={15} />
          </button>
          {running && session && (
            <button type="button" className="nova-composer-stop" title={lang === "th" ? "หยุดงานนี้" : "Stop this run"} onClick={() => void novaApi.stopSession(session.conversationId)}>
              <Square size={11} />
            </button>
          )}
        </div>
          </div>
        </div>
      </div>
      {!cliOk && !running && <div className="ide-note-small">agy.exe not found — reply works only while a run is active.</div>}
    </div>
  );
};

/** Start a brand-new headless run in any workspace (supports text + images). */
export const NewRunBar: React.FC<{
  snapshot: NovaSnapshot;
  lang: Lang;
  workspacePath?: string;
  onStarted?: () => void;
}> = ({ snapshot, lang, workspacePath, onStarted }) => {
  const [ws, setWs] = useState(workspacePath ?? "");
  const [prompt, setPrompt] = useState("");
  const [images, setImages] = useState<AttachedImageItem[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [attachmentMenuOpen, setAttachmentMenuOpen] = useState(false);
  const [attachmentMenuPosition, setAttachmentMenuPosition] = useState<{ top: number; left: number } | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [model, setModel] = useState(() => {
    try { return localStorage.getItem("nova.agy.defaultModel") ?? ""; } catch { return ""; }
  });
  const newRunInputRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const attachWrapRef = useRef<HTMLDivElement | null>(null);
  const attachmentMenuRef = useRef<HTMLDivElement | null>(null);
  useCloseWhenIslandFolds(attachmentMenuOpen, () => setAttachmentMenuOpen(false));
  useUpdateIslandPopoverHitRegion(attachmentMenuOpen, attachmentMenuPosition, attachmentMenuRef);
  const list = snapshot.recentWorkspaces ?? [];

  useEffect(() => {
    try {
      if (model) localStorage.setItem("nova.agy.defaultModel", model);
      else localStorage.removeItem("nova.agy.defaultModel");
    } catch { /* Keep model selection usable if storage is unavailable. */ }
  }, [model]);

  useEffect(() => {
    if (!attachmentMenuOpen) return;
    const closeOnOutside = (e: PointerEvent) => {
      if (!attachWrapRef.current?.contains(e.target as Node) && !attachmentMenuRef.current?.contains(e.target as Node)) setAttachmentMenuOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutside);
    return () => document.removeEventListener("pointerdown", closeOnOutside);
  }, [attachmentMenuOpen]);

  useLayoutEffect(() => {
    if (!attachmentMenuOpen) {
      setAttachmentMenuPosition(null);
      return;
    }
    if (!attachWrapRef.current) return;
    const button = attachWrapRef.current.querySelector<HTMLElement>(".nova-composer-add");
    const rect = button?.getBoundingClientRect();
    if (!rect) return;
    const height = attachmentMenuRef.current?.scrollHeight ?? 76;
    const menuWidth = attachmentMenuRef.current?.offsetWidth || 205;
    const placement = computePopoverPlacement({
      triggerRect: rect,
      desiredHeight: height,
      menuWidth,
      viewportW: window.innerWidth,
      viewportH: window.innerHeight,
      gap: 9,
      margin: 8,
    });
    setAttachmentMenuPosition({ top: placement.top, left: placement.left });
  }, [attachmentMenuOpen]);

  useEffect(() => {
    if (workspacePath !== undefined) setWs(workspacePath);
  }, [workspacePath]);

  useEffect(() => {
    const focusTimer = window.setTimeout(() => newRunInputRef.current?.focus(), 80);
    return () => window.clearTimeout(focusTimer);
  }, []);

  const appendImages = (incoming: AttachedImageItem[]) => {
    if (incoming.length === 0) return;
    setImages((prev) => [...prev, ...incoming].slice(0, MAX_IMAGES));
  };

  const handlePaste = async (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const pastedFiles = extractImageFilesFromClipboard(e.clipboardData);
    if (pastedFiles.length > 0) {
      e.preventDefault();
      const loaded = await filesToAttachedImages(pastedFiles);
      appendImages(loaded);
      return;
    }

    const plain = e.clipboardData?.getData("text/plain") ?? "";
    if (!plain) {
      e.preventDefault();
      const cb = await novaApi.readClipboardImage();
      if (cb.ok && cb.dataUrl) {
        appendImages([
          {
            id: `cb-${Date.now()}`,
            dataUrl: cb.dataUrl,
            name: cb.name || "clipboard.png",
          },
        ]);
      }
    }
  };

  const go = async () => {
    if (!prompt.trim() && images.length === 0) return;
    const r = await novaApi.sendSessionPrompt({
      workspacePath: ws,
      prompt: prompt.replace(/\r\n?/g, "\n").replace(/^\n+|\s+$/g, ""),
      mode: "auto",
      model: model || null,
      imageDataUrl: images[0]?.dataUrl ?? null,
      images: images.map((img) => ({ dataUrl: img.dataUrl, name: img.name })),
    });
    setMsg(r.ok ? null : r.error ?? "Failed");
    if (r.ok) {
      setPrompt("");
      setImages([]);
      if (newRunInputRef.current) newRunInputRef.current.style.height = "24px";
      onStarted?.();
    }
  };

  return (
    <div
      className={`cockpit newrun ${dragOver ? "is-dragover" : ""}`}
      onDragOver={(e) => {
        if (e.dataTransfer?.types?.includes("Files")) {
          e.preventDefault();
          e.stopPropagation();
          setDragOver(true);
        }
      }}
      onDragLeave={(e) => {
        e.stopPropagation();
        setDragOver(false);
      }}
      onDrop={async (e) => {
        e.preventDefault();
        e.stopPropagation();
        setDragOver(false);
        if (e.dataTransfer?.files?.length) {
          const loaded = await filesToAttachedImages(Array.from(e.dataTransfer.files));
          appendImages(loaded);
        }
      }}
    >
      {!workspacePath && <div className="project-picker-topline">
        <div className="project-picker-selection">
          <FolderOpen size={17} />
          <span className={ws ? "has-project" : ""} title={ws || undefined}>
            {ws ? (list.find((w) => w.path === ws)?.name || ws) : lang === "th" ? "ยังไม่ได้เลือกโปรเจกต์" : "No project selected"}
          </span>
        </div>
        <button
          type="button"
          className="nova-btn nova-btn-primary project-folder-button"
          onClick={async () => {
            try {
              const { open } = await import("@tauri-apps/plugin-dialog");
              const selected = await open({ directory: true, multiple: false, title: lang === "th" ? "เลือกโฟลเดอร์โปรเจกต์" : "Select project folder" });
              if (typeof selected === "string") {
                setWs(selected);
                setMsg(null);
              }
            } catch {
              setMsg(lang === "th" ? "เปิดตัวเลือกโฟลเดอร์ไม่ได้" : "Could not open the folder picker.");
            }
          }}
        >
          <FolderOpen size={15} /> {lang === "th" ? "เลือกโฟลเดอร์" : "Choose project folder"}
        </button>
      </div>}
      {!workspacePath && list.length > 0 && (
        <div className="project-recent-list" aria-label={lang === "th" ? "โปรเจกต์ล่าสุด" : "Recent projects"}>
          <span>{lang === "th" ? "ล่าสุด" : "Recent"}</span>
          {list.slice(0, 5).map((w) => (
            <button key={w.path} type="button" className={`project-recent-chip ${ws === w.path ? "selected" : ""}`} title={w.path} onClick={() => setWs(w.path)}>
              <FolderOpen size={12} /> {w.name}
            </button>
          ))}
        </div>
      )}
      <AttachmentStrip
        images={images}
        onRemove={(id) => setImages((prev) => prev.filter((item) => item.id !== id))}
      />
      <input
        ref={fileInputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif,image/bmp,image/*"
        multiple
        hidden
        onChange={async (e) => {
          const listFiles = e.target.files ? Array.from(e.target.files) : [];
          e.target.value = "";
          if (listFiles.length > 0) {
            const loaded = await filesToAttachedImages(listFiles);
            appendImages(loaded);
          }
        }}
      />
      <div className="nova-agent-composer">
        <div className="nova-composer-input-row">
        <textarea
          ref={newRunInputRef}
          rows={1}
          className="nova-textarea cockpit-input"
          value={prompt}
          placeholder={lang === "th" ? "บอก NOVA ว่าต้องการทำอะไร…" : "Message your agent…"}
          onChange={(e) => {
            setPrompt(e.target.value);
            autoResizeNewRunTextarea(e.currentTarget);
          }}
          onPaste={(e) => void handlePaste(e)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void go();
            }
          }}
        />
        </div>
        <div className="nova-composer-toolbar">
          <div className="nova-composer-tools-left">
        <div className="nova-composer-add-wrap" ref={attachWrapRef}>
          <button
            type="button"
            className={`nova-composer-add ${images.length > 0 ? "has-attachments" : ""}`}
            aria-label={lang === "th" ? "เพิ่มไฟล์แนบ" : "Add attachment"}
            aria-expanded={attachmentMenuOpen}
            title={lang === "th" ? "เพิ่มไฟล์แนบ" : "Add attachment"}
            onClick={() => setAttachmentMenuOpen((open) => !open)}
          >
            <Plus size={17} />
            {images.length > 0 && <span>{images.length}</span>}
          </button>
          {attachmentMenuOpen && createPortal(
            <div
              ref={attachmentMenuRef}
              className="nova-composer-menu is-portaled"
              data-nova-island-hover-region={attachmentMenuPosition ? "true" : undefined}
              style={{ top: `${attachmentMenuPosition?.top ?? -10000}px`, left: `${attachmentMenuPosition?.left ?? 8}px`, visibility: attachmentMenuPosition ? "visible" : "hidden" }}
              role="menu"
            >
              <button type="button" role="menuitem" onClick={(e) => { notifyIslandPopoverSelect(e); setAttachmentMenuOpen(false); fileInputRef.current?.click(); }}>
                <ImagePlus size={15} /><span>{lang === "th" ? "แนบรูปภาพ" : "Attach image"}</span><kbd>Ctrl V</kbd>
              </button>
              <button type="button" role="menuitem" onClick={async (e) => {
                notifyIslandPopoverSelect(e);
                setAttachmentMenuOpen(false);
                const r = await novaApi.captureScreenSnip();
                if (r.ok && r.dataUrl) appendImages([{ id: `snip-${Date.now()}`, dataUrl: r.dataUrl, name: `screen-${new Date().toTimeString().slice(0, 8).replace(/:/g, "")}.png` }]);
              }}>
                <Camera size={15} /><span>{lang === "th" ? "จับภาพหน้าจอ" : "Capture screen"}</span>
              </button>
            </div>,
            document.body,
          )}
        </div>
        {ws && (
          <AgyModelPicker
            value={model}
            onChange={setModel}
            lang={lang}
            defaultOptionLabel={lang === "th" ? "AGY ค่าเริ่มต้น" : "AGY default"}
            triggerFallbackLabel={lang === "th" ? "AGY ค่าเริ่มต้น" : "AGY default"}
            onOpen={() => setAttachmentMenuOpen(false)}
          />
        )}
          </div>
          <div className="nova-composer-tools-right">
            {ws && <PermissionPill snapshot={snapshot} />}
        <div className="nova-composer-actions">
          <button type="button" className="nova-composer-send" disabled={!ws || (!prompt.trim() && images.length === 0)} onClick={() => void go()} title={lang === "th" ? "ส่งข้อความ" : "Send message"}>
            <Send size={15} />
          </button>
        </div>
          </div>
        </div>
      </div>
      {msg && <div className="ide-note-small">{msg}</div>}
    </div>
  );
};
