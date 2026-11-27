export interface HoverRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const ISLAND_HOVER_REGION_EVENT = "nova-island-hover-region-change";
export const ISLAND_POPOVER_SELECT_EVENT = "nova-island-popover-select";

export interface IslandPopoverSelectDetail {
  clientX: number;
  clientY: number;
}

export function isPointInRect(x: number, y: number, rect: HoverRect): boolean {
  return (
    rect.w > 0 &&
    rect.h > 0 &&
    x >= rect.x &&
    x <= rect.x + rect.w &&
    y >= rect.y &&
    y <= rect.y + rect.h
  );
}

/**
 * Places a floating popover above its trigger whenever sufficient vertical space exists above;
 * drops below only when space above cannot fit `desiredHeight` and there is more space below.
 */
export function computePopoverPlacement(params: {
  triggerRect: { top: number; bottom: number; left: number; right: number };
  desiredHeight: number;
  menuWidth: number;
  viewportW: number;
  viewportH: number;
  gap?: number;
  margin?: number;
}): {
  top: number;
  left: number;
  dropDown: boolean;
  availableHeight: number;
  panelHeight: number;
} {
  const gap = params.gap ?? 6;
  const margin = params.margin ?? 8;
  const { triggerRect, desiredHeight, menuWidth, viewportW, viewportH } = params;

  const spaceAbove = Math.max(0, triggerRect.top - margin - gap);
  const spaceBelow = Math.max(0, viewportH - triggerRect.bottom - margin - gap);

  // Open above if there is space above; open below only when space above is insufficient.
  const dropDown = spaceAbove < desiredHeight && spaceBelow > spaceAbove;
  const availableHeight = Math.max(48, dropDown ? spaceBelow : spaceAbove);
  const panelHeight = Math.min(desiredHeight, availableHeight);

  const clampedWidth = Math.min(menuWidth, Math.max(120, viewportW - margin * 2));
  const left = Math.max(
    margin,
    Math.min(triggerRect.left, viewportW - clampedWidth - margin)
  );
  const top = dropDown
    ? triggerRect.bottom + gap
    : Math.max(margin, triggerRect.top - panelHeight - gap);

  return {
    top,
    left,
    dropDown,
    availableHeight,
    panelHeight,
  };
}

/**
 * Converts open external popover DOM rects into distinct hover regions (never a giant
 * full-island bounding box), bridging only the narrow seam between each popover and `mainRect`.
 */
export function buildPopoverExtraRects(
  mainRect: HoverRect,
  popoverRects: readonly HoverRect[],
  pad = 0,
  maxBridgeGap = 22
): HoverRect[] {
  if (mainRect.w <= 0 || mainRect.h <= 0 || popoverRects.length === 0) {
    return [];
  }

  const mainLeft = mainRect.x;
  const mainTop = mainRect.y;
  const mainRight = mainRect.x + mainRect.w;
  const mainBottom = mainRect.y + mainRect.h;

  const out: HoverRect[] = [];
  for (const raw of popoverRects) {
    if (!Number.isFinite(raw.x) || !Number.isFinite(raw.y) || raw.w <= 0 || raw.h <= 0) {
      continue;
    }

    const left = raw.x - pad;
    let top = raw.y - pad;
    const right = raw.x + raw.w + pad;
    let bottom = raw.y + raw.h + pad;

    const overlapsMainX = right >= mainLeft - pad && left <= mainRight + pad;
    if (overlapsMainX) {
      if (top > mainBottom && top - mainBottom <= maxBridgeGap) {
        top = mainBottom;
      } else if (bottom < mainTop && mainTop - bottom <= maxBridgeGap) {
        bottom = mainTop;
      }
    }

    // Skip if already completely enclosed within the main island silhouette.
    if (
      left >= mainLeft &&
      right <= mainRight &&
      top >= mainTop &&
      bottom <= mainBottom
    ) {
      continue;
    }

    out.push({
      x: left,
      y: top,
      w: Math.max(0, right - left),
      h: Math.max(0, bottom - top),
    });
  }

  return out;
}

export function hitTestIslandRegions(
  x: number,
  y: number,
  mainRect: HoverRect,
  extraRects: readonly HoverRect[],
  isExpanded: boolean
): { inside: boolean; onMain: boolean } {
  const onMain = isPointInRect(x, y, mainRect);
  const inExtra = isExpanded && extraRects.some((r) => isPointInRect(x, y, r));
  return {
    inside: onMain || inExtra,
    onMain,
  };
}

/**
 * Determines whether selecting a popover option should temporarily disable island collapse:
 * - True when the click occurred outside `mainRect` (e.g. a modal opened below the island).
 * - False when the pointer is already inside `mainRect`, so normal hover/leave stays active.
 */
export function resolvePopoverSelectCollapseLock(
  clickX: number,
  clickY: number,
  fallbackPointer: { x: number; y: number } | null,
  mainRect: HoverRect
): boolean {
  const hasClickCoords =
    Number.isFinite(clickX) &&
    Number.isFinite(clickY) &&
    (clickX > 0 || clickY > 0);
  const pt = hasClickCoords ? { x: clickX, y: clickY } : fallbackPointer;
  if (!pt || !Number.isFinite(pt.x) || !Number.isFinite(pt.y)) {
    return false;
  }
  return !isPointInRect(pt.x, pt.y, mainRect);
}

/**
 * Pure hover state-machine transition for every pointer update:
 * - While `suppressCollapseUntilMainReturn` is active, leaving/staying outside `mainRect`
 *   holds the island open; entering `mainRect` clears the lock and resumes normal hover behavior.
 * - When unlocked, `inside` (`onMain || inOpenModal`) keeps the island open, and moving outside
 *   collapses both the island and any open modal.
 */
export function stepIslandPointerHoverState(params: {
  inside: boolean;
  onMain: boolean;
  suppressCollapseUntilMainReturn: boolean;
  pointerInside: boolean;
}): {
  nextSuppressCollapse: boolean;
  action: "enter" | "leave" | "hold" | "none";
} {
  const { inside, onMain, suppressCollapseUntilMainReturn, pointerInside } = params;

  if (suppressCollapseUntilMainReturn) {
    if (onMain) {
      return { nextSuppressCollapse: false, action: "enter" };
    }
    if (inside) {
      return { nextSuppressCollapse: true, action: "enter" };
    }
    return { nextSuppressCollapse: true, action: "hold" };
  }

  if (inside) {
    return { nextSuppressCollapse: false, action: "enter" };
  }

  return {
    nextSuppressCollapse: false,
    action: pointerInside ? "leave" : "none",
  };
}

export function notifyIslandPopoverSelect(
  event?: { clientX?: number; clientY?: number } | null
): void {
  if (typeof window === "undefined") return;
  const clientX = typeof event?.clientX === "number" ? event.clientX : -1;
  const clientY = typeof event?.clientY === "number" ? event.clientY : -1;
  window.dispatchEvent(
    new CustomEvent<IslandPopoverSelectDetail>(ISLAND_POPOVER_SELECT_EVENT, {
      detail: { clientX, clientY },
    })
  );
}
