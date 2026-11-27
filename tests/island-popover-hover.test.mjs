import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

async function loadIslandHoverModule() {
  const tsPath = path.resolve("src/lib/islandHover.ts");
  const source = fs.readFileSync(tsPath, "utf8");
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
  });
  const dataUrl = `data:text/javascript;base64,${Buffer.from(
    transpiled.outputText,
    "utf8"
  ).toString("base64")}`;
  return import(dataUrl);
}

test("Popover placement opens ABOVE when space above fits, and BELOW only when space above is too compact", async () => {
  const { computePopoverPlacement } = await loadIslandHoverModule();

  // 1. Expanded session island with plenty of space above AND below -> MUST open ABOVE
  const whenSpaceAboveFits = computePopoverPlacement({
    triggerRect: { top: 440, bottom: 468, left: 620, right: 690 },
    desiredHeight: 176,
    menuWidth: 254,
    viewportW: 900,
    viewportH: 690,
    gap: 7,
    margin: 8,
  });
  assert.equal(
    whenSpaceAboveFits.dropDown,
    false,
    "Must open above when there is enough space above, even if space below also fits"
  );
  assert.equal(whenSpaceAboveFits.top, 440 - 176 - 7);

  // 2. Compact island near top of screen (e.g. New chat) -> insufficient space above, opens BELOW
  const whenCompactAtTop = computePopoverPlacement({
    triggerRect: { top: 152, bottom: 180, left: 620, right: 690 },
    desiredHeight: 176,
    menuWidth: 254,
    viewportW: 900,
    viewportH: 690,
    gap: 7,
    margin: 8,
  });
  assert.equal(
    whenCompactAtTop.dropDown,
    true,
    "Must open below when compact island leaves insufficient space above"
  );
  assert.equal(whenCompactAtTop.top, 180 + 7);

  // 3. Small '+' attachment menu in compact island where 82px DOES fit above -> opens ABOVE
  const smallMenuFitsAbove = computePopoverPlacement({
    triggerRect: { top: 152, bottom: 180, left: 48, right: 76 },
    desiredHeight: 82,
    menuWidth: 205,
    viewportW: 900,
    viewportH: 690,
    gap: 9,
    margin: 8,
  });
  assert.equal(
    smallMenuFitsAbove.dropDown,
    false,
    "Small attachment menu should still open above when compact space above is sufficient"
  );

  // 4. Bottom-docked island -> plenty of space above, tiny space below -> opens ABOVE
  const bottomDocked = computePopoverPlacement({
    triggerRect: { top: 628, bottom: 656, left: 200, right: 320 },
    desiredHeight: 260,
    menuWidth: 306,
    viewportW: 900,
    viewportH: 690,
    gap: 6,
    margin: 8,
  });
  assert.equal(bottomDocked.dropDown, false);
});

test("Hover area equals ONLY main island when closed, and exact (main island U modal) when modal is open", async () => {
  const { buildPopoverExtraRects, hitTestIslandRegions } = await loadIslandHoverModule();

  const mainRect = { x: 30, y: 8, w: 840, h: 188 }; // y: 8..196

  // No modal open -> extraRects is empty, hover area is strictly mainRect
  const closedExtras = buildPopoverExtraRects(mainRect, []);
  assert.deepEqual(closedExtras, []);
  assert.deepEqual(hitTestIslandRegions(200, 100, mainRect, closedExtras, true), {
    inside: true,
    onMain: true,
  });
  assert.deepEqual(hitTestIslandRegions(700, 260, mainRect, closedExtras, true), {
    inside: false,
    onMain: false,
  });

  // Modal open ABOVE and fully enclosed within main island -> no extra protrusion needed
  const enclosedExtras = buildPopoverExtraRects(
    { x: 30, y: 8, w: 840, h: 500 },
    [{ x: 180, y: 170, w: 306, h: 260 }]
  );
  assert.deepEqual(enclosedExtras, []);

  // Modal open BELOW right side (like Smart or Model menu in compact mode) with a 6px visual gap
  const openBelowExtras = buildPopoverExtraRects(mainRect, [
    { x: 590, y: 202, w: 254, h: 180 },
  ]);
  assert.equal(openBelowExtras.length, 1);

  // 1) Seamless bridge across the 6px gap between mainRect (y=196) and modal (y=202)
  assert.deepEqual(hitTestIslandRegions(700, 199, mainRect, openBelowExtras, true), {
    inside: true,
    onMain: false,
  });

  // 2) Inside modal UI -> counts as island hover area, but onMain is false
  assert.deepEqual(hitTestIslandRegions(700, 300, mainRect, openBelowExtras, true), {
    inside: true,
    onMain: false,
  });

  // 3) Moving mouse out of hover area (left of modal / below main island) -> outside, so island + modal can collapse!
  assert.deepEqual(hitTestIslandRegions(300, 260, mainRect, openBelowExtras, true), {
    inside: false,
    onMain: false,
  });
  assert.deepEqual(hitTestIslandRegions(700, 410, mainRect, openBelowExtras, true), {
    inside: false,
    onMain: false,
  });
  assert.deepEqual(hitTestIslandRegions(865, 260, mainRect, openBelowExtras, true), {
    inside: false,
    onMain: false,
  });
});

test("Selecting modal option outside main island disables collapse until mouse returns to main island, then acts normal", async () => {
  const {
    buildPopoverExtraRects,
    hitTestIslandRegions,
    resolvePopoverSelectCollapseLock,
    stepIslandPointerHoverState,
  } = await loadIslandHoverModule();

  const mainRect = { x: 30, y: 8, w: 840, h: 188 }; // y: 8..196
  const modalRect = { x: 590, y: 190, w: 254, h: 190 };

  let suppressCollapse = false;
  let pointerInside = true;

  // Step 1: Modal is open; user moves cursor into modal at (700, 280)
  let extras = buildPopoverExtraRects(mainRect, [modalRect]);
  let hit = hitTestIslandRegions(700, 280, mainRect, extras, true);
  assert.deepEqual(hit, { inside: true, onMain: false });
  let step = stepIslandPointerHoverState({
    inside: hit.inside,
    onMain: hit.onMain,
    suppressCollapseUntilMainReturn: suppressCollapse,
    pointerInside,
  });
  assert.deepEqual(step, { nextSuppressCollapse: false, action: "enter" });

  // Step 1b: If user moves out WITHOUT clicking an option -> collapses immediately!
  const leaveWithoutClickHit = hitTestIslandRegions(350, 280, mainRect, extras, true);
  const leaveWithoutClickStep = stepIslandPointerHoverState({
    inside: leaveWithoutClickHit.inside,
    onMain: leaveWithoutClickHit.onMain,
    suppressCollapseUntilMainReturn: false,
    pointerInside: true,
  });
  assert.deepEqual(leaveWithoutClickStep, {
    nextSuppressCollapse: false,
    action: "leave",
  });

  // Step 2: User clicks a model/permission option at (700, 280) (outside main island)
  suppressCollapse = resolvePopoverSelectCollapseLock(
    700,
    280,
    { x: 700, y: 280 },
    mainRect
  );
  assert.equal(suppressCollapse, true, "Click outside main island must disable collapse");

  // Modal closes -> hover region immediately shrinks back to ONLY main island
  extras = buildPopoverExtraRects(mainRect, []);
  assert.deepEqual(extras, []);

  // Step 3: Mouse is still outside main island at (700, 280) or moves to (650, 310) -> island MUST NOT collapse
  hit = hitTestIslandRegions(650, 310, mainRect, extras, true);
  assert.deepEqual(hit, { inside: false, onMain: false });
  step = stepIslandPointerHoverState({
    inside: hit.inside,
    onMain: hit.onMain,
    suppressCollapseUntilMainReturn: suppressCollapse,
    pointerInside,
  });
  assert.deepEqual(step, { nextSuppressCollapse: true, action: "hold" });
  suppressCollapse = step.nextSuppressCollapse;

  // Step 4: User moves mouse back onto main island at (500, 140) -> re-enables collapse!
  hit = hitTestIslandRegions(500, 140, mainRect, extras, true);
  assert.deepEqual(hit, { inside: true, onMain: true });
  step = stepIslandPointerHoverState({
    inside: hit.inside,
    onMain: hit.onMain,
    suppressCollapseUntilMainReturn: suppressCollapse,
    pointerInside,
  });
  assert.deepEqual(step, { nextSuppressCollapse: false, action: "enter" });
  suppressCollapse = step.nextSuppressCollapse;
  pointerInside = true;

  // Step 5: User later moves mouse out of main island at (500, 250) -> collapses normally!
  hit = hitTestIslandRegions(500, 250, mainRect, extras, true);
  assert.deepEqual(hit, { inside: false, onMain: false });
  step = stepIslandPointerHoverState({
    inside: hit.inside,
    onMain: hit.onMain,
    suppressCollapseUntilMainReturn: suppressCollapse,
    pointerInside,
  });
  assert.deepEqual(step, { nextSuppressCollapse: false, action: "leave" });
});

test("Selecting modal option when cursor is ALREADY inside main island keeps collapse enabled normally", async () => {
  const {
    hitTestIslandRegions,
    resolvePopoverSelectCollapseLock,
    stepIslandPointerHoverState,
  } = await loadIslandHoverModule();

  const expandedMainRect = { x: 30, y: 8, w: 840, h: 480 }; // y: 8..488

  // Modal opened ABOVE inside main island; user clicks option at (240, 260) inside mainRect
  const suppressCollapse = resolvePopoverSelectCollapseLock(
    240,
    260,
    { x: 240, y: 260 },
    expandedMainRect
  );
  assert.equal(
    suppressCollapse,
    false,
    "Click already inside main island must keep normal collapse enabled"
  );

  // Moving mouse out of main island immediately collapses as normal
  const hitOut = hitTestIslandRegions(240, 520, expandedMainRect, [], true);
  const stepOut = stepIslandPointerHoverState({
    inside: hitOut.inside,
    onMain: hitOut.onMain,
    suppressCollapseUntilMainReturn: suppressCollapse,
    pointerInside: true,
  });
  assert.deepEqual(stepOut, { nextSuppressCollapse: false, action: "leave" });
});

test("IslandSurface and SessionCockpit wire multi-rect hit-testing without legacy bounding-box or ghost-rect bugs", () => {
  const islandSrc = fs.readFileSync(path.resolve("src/surfaces/IslandSurface.tsx"), "utf8");
  const cockpitSrc = fs.readFileSync(path.resolve("src/components/SessionCockpit.tsx"), "utf8");
  const libRs = fs.readFileSync(path.resolve("src-tauri/src/lib.rs"), "utf8");

  assert.equal(
    islandSrc.includes("heldPopoverRectRef"),
    false,
    "IslandSurface must not hold ghost popover hit-rects after a popover closes"
  );
  assert.ok(
    islandSrc.includes("suppressCollapseUntilMainReturnRef") &&
      islandSrc.includes("ISLAND_POPOVER_SELECT_EVENT") &&
      islandSrc.includes("collectPopoverExtraRects"),
    "IslandSurface must track multi-rect popover regions and post-selection main-island return"
  );
  assert.ok(
    cockpitSrc.includes("computePopoverPlacement") &&
      cockpitSrc.includes("notifyIslandPopoverSelect"),
    "SessionCockpit popovers must use upward-first placement and emit explicit option-select events"
  );
  assert.ok(
    libRs.includes("extra_rects") &&
      libRs.includes("hit_test_island_stage") &&
      libRs.includes("last_rect_seq") &&
      libRs.includes("CalculateNativeWinOcclusion"),
    "Tauri hit-tester must evaluate distinct extra_rects, enforce monotonic IPC sequence ordering, and disable WebView2 window occlusion throttling"
  );
  const sysToolsRs = fs.readFileSync(path.resolve("src-tauri/src/system_tools.rs"), "utf8");
  assert.ok(
    sysToolsRs.includes("WorkerW") && sysToolsRs.includes("is_foreground_fullscreen_on_monitor"),
    "Fullscreen suppression check must exclude Windows WorkerW/Shell hosts and scope to the island monitor"
  );

  // Verify symmetric pill layout ([Orb] -> centered nova-closed-label -> right aura waveform)
  // and island-first width expansion + Apple blur-glide text reveal
  const labelIdx = islandSrc.indexOf("displayedClosedStatus.text");
  const waveIdx = islandSrc.indexOf("nova-pill-waveform", labelIdx);
  assert.ok(
    labelIdx > 0 && waveIdx > labelIdx,
    "Aura waveform indicator must be placed to the right of the centered pill status label"
  );
  assert.ok(
    islandSrc.includes("shouldExpandIslandFirst") &&
      islandSrc.includes("pillSizerRef") &&
      islandSrc.includes("is-awaiting-island") &&
      islandSrc.includes("nova-pill-blur-glide"),
    "Folded pill must measure incoming text offscreen, expand the island capsule first, and reveal text with Apple blur-glide"
  );

  // Verify hit_test_island_stage has zero top/bottom bezel cushion or side pad_x
  // so moving the cursor in the top gap above the pill NEVER triggers an expand/collapse loop!
  assert.equal(
    libRs.includes("let pad_x ="),
    false,
    "hit_test_island_stage must not inflate horizontal pill bounds with pad_x"
  );
  assert.equal(
    libRs.includes("-6.0"),
    false,
    "hit_test_island_stage must not extend hover detection into the top gap above the island"
  );
});
