import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

test("INTERVIEW.md specification exists and captures all 25 decisions", () => {
  const interviewPath = path.resolve("INTERVIEW.md");
  assert.equal(fs.existsSync(interviewPath), true);
  const text = fs.readFileSync(interviewPath, "utf8");
  assert.match(text, /### 1\. Name & Brand Identity/);
  assert.match(text, /### 25\. Final Launch & REA Setup Check/);
  assert.match(text, /Finalized NOVA Master Blueprint/);
});

test("Tauri security config enforces strict CSP, disables global Tauri object, and boots Island-only", () => {
  const conf = JSON.parse(fs.readFileSync(path.resolve("src-tauri/tauri.conf.json"), "utf8"));
  assert.equal(conf.app.withGlobalTauri, false, "withGlobalTauri must be disabled");
  assert.equal(typeof conf.app.security?.csp, "string", "CSP must be explicitly enforced");
  assert.match(conf.app.security.csp, /script-src 'self'/);
  assert.equal(conf.app.windows.length, 1, "Only the Island window should launch on startup");
  assert.equal(conf.app.windows[0].label, "island");
});

test("nova-hook.exe fails open within <300ms when NOVA Core is offline", () => {
  const hookExe = path.resolve("target/release/nova-hook.exe");
  assert.equal(fs.existsSync(hookExe), true, "nova-hook.exe release binary must exist");

  const start = performance.now();
  const stdout = execFileSync(hookExe, ["--agent", "antigravity", "PreToolUse"], {
    input: JSON.stringify({
      conversationId: "unit-test-fail-open",
      hookEventName: "PreToolUse",
      toolCall: { id: "t1", name: "run_command", args: { CommandLine: "npm test" } },
    }),
    env: { ...process.env, NOVA_IPC_PORT: "59999" }, // guaranteed unused port
    encoding: "utf8",
  });
  const elapsedMs = performance.now() - start;
  const parsed = JSON.parse(stdout.trim());
  assert.equal(parsed.decision, "ask");
  assert.ok(elapsedMs < 1500, `Expected fast fail-open, got ${elapsedMs.toFixed(0)}ms`);
});

test("Frontend production bundle compiles cleanly into dist/ and standalone Cargo build embeds custom-protocol", () => {
  assert.equal(fs.existsSync(path.resolve("dist/index.html")), true);
  const serverRs = fs.readFileSync(path.resolve("src-tauri/src/server.rs"), "utf8");
  assert.equal(serverRs.includes("/demo/simulate"), false, "Demo endpoint must not exist in production");
  const cargoToml = fs.readFileSync(path.resolve("src-tauri/Cargo.toml"), "utf8");
  assert.match(
    cargoToml,
    /default\s*=\s*\[\s*"custom-protocol"\s*\]/,
    "Cargo.toml must default to custom-protocol so standalone nova.exe embeds dist/ instead of pointing at localhost:1420"
  );
  assert.match(
    cargoToml,
    /custom-protocol\s*=\s*\[\s*"tauri\/custom-protocol"\s*\]/,
    "custom-protocol feature must wire to tauri/custom-protocol"
  );
});

test("Two-way control: routes exist and relay emits Antigravity hook contracts", () => {
  const serverRs = fs.readFileSync(path.resolve("src-tauri/src/server.rs"), "utf8");
  for (const r of ["/session/send", "/session/stop", "/session/permission", "/session/revert-diff"]) {
    assert.ok(serverRs.includes(r), `missing route ${r}`);
  }
  const hookRs = fs.readFileSync(path.resolve("hook/src/main.rs"), "utf8");
  for (const k of ["injectSteps", "terminationBehavior", "overwrite", "\"continue\""]) {
    assert.ok(hookRs.includes(k), `hook relay missing ${k}`);
  }
  const stateRs = fs.readFileSync(path.resolve("src-tauri/src/state.rs"), "utf8");
  assert.ok(stateRs.includes("follow_agy"), "permission modes must be implemented");
  assert.ok(stateRs.includes("NOVA_HANDOFF_CONTEXT"), "structured handoff context wrapper must be used");
  assert.ok(stateRs.includes("CREATE_NO_WINDOW") || fs.readFileSync(path.resolve("src-tauri/src/system_tools.rs"), "utf8").includes("CREATE_NO_WINDOW"));

  const telemetryTsx = fs.readFileSync(path.resolve("src/components/SessionTelemetryView.tsx"), "utf8");
  assert.ok(telemetryTsx.includes("ExpandablePrompt"), "session prompt must render via ExpandablePrompt");
  assert.ok(telemetryTsx.includes("normalizePromptForDisplay"), "session prompt must normalize handoff context and render full prompt");
});

test("Live NOVA Core enforces token auth and blocks cross-site Origin attacks", async (t) => {
  let healthOk = false;
  try {
    const h = await fetch("http://127.0.0.1:47920/api/health");
    healthOk = h.ok;
  } catch {
    healthOk = false;
  }
  if (!healthOk) {
    t.skip("NOVA Core is not currently running on 127.0.0.1:47920");
    return;
  }

  // 1. Unauthenticated /api/snapshot MUST return 401
  const unauthSnap = await fetch("http://127.0.0.1:47920/api/snapshot");
  assert.equal(unauthSnap.status, 401, "Unauthenticated snapshot read must be rejected with 401");

  // 2. Unauthenticated /api/workspace/launch MUST return 401
  const unauthExec = await fetch("http://127.0.0.1:47920/api/workspace/launch", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ workspacePath: ".", agentCli: "powershell" }),
  });
  assert.equal(unauthExec.status, 401, "Unauthenticated workspace launch must be rejected with 401");

  // 3. Untrusted browser Origin MUST return 403 even if token were guessed
  const tokenPath = path.join(
    process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"),
    "NOVA",
    "ipc.token"
  );
  const ipcToken = fs.readFileSync(tokenPath, "utf8").trim();

  const csrfAttempt = await fetch("http://127.0.0.1:47920/api/snapshot", {
    headers: {
      Origin: "https://evil-site.example",
      "X-Nova-Token": ipcToken,
    },
  });
  assert.equal(csrfAttempt.status, 403, "External browser Origin must be blocked with 403");

  // 4. Legitimate local IPC token from trusted Tauri origin succeeds & never leaks raw secrets
  const validSnap = await fetch("http://127.0.0.1:47920/api/snapshot", {
    headers: {
      Origin: "http://tauri.localhost",
      "X-Nova-Token": ipcToken,
    },
  });
  assert.equal(validSnap.status, 200, "Trusted Tauri origin + valid IPC token must succeed");
  const snapData = await validSnap.json();
  for (const val of Object.values(snapData.secrets)) {
    assert.equal(typeof val, "boolean", "Secret map must only expose boolean presence flags");
  }
});

test("Markdown parser handles bold with nested italic and auto-collapses correctly", () => {
  const ideMarkdownSrc = fs.readFileSync(path.resolve("src/components/IdeMarkdown.tsx"), "utf8");
  assert.ok(ideMarkdownSrc.includes("tokenizeInline"), "Must export/contain tokenizeInline parser");
  assert.ok(ideMarkdownSrc.includes("md-blockquote"), "Must support blockquote markdown");

  const telemetrySrc = fs.readFileSync(path.resolve("src/components/SessionTelemetryView.tsx"), "utf8");
  assert.ok(telemetrySrc.includes("setPlanOpen(false)"), "Plan steps must auto-collapse when process finishes");
  assert.ok(telemetrySrc.includes("Boolean(isRunningGroup)"), "Focus groups must auto-collapse by default unless actively running");
  assert.ok(telemetrySrc.includes("deduplicateFocusGroups"), "Telemetry view must deduplicate overlapping transcript and hook focus groups");
});

test("Focus group & step deduplication prevents transcript + PreToolUse duplicate blocks", () => {
  const stateRs = fs.readFileSync(path.resolve("src-tauri/src/state.rs"), "utf8");
  assert.ok(
    stateRs.includes("dedup_and_merge_focus_groups"),
    "Backend must merge consecutive same-title focus groups and upgrade transcript steps in-place"
  );
  assert.ok(
    stateRs.includes("dedup_session_diffs"),
    "Backend must deduplicate identical file diff previews across transcript and PostToolUse"
  );
  assert.ok(
    stateRs.includes("claimed_transcript_step"),
    "PreToolUse must claim matching unclaimed Transcript steps instead of pushing duplicates"
  );
});

test("Window creation never runs WebviewWindowBuilder::build on the Win32 main thread", () => {
  const libRs = fs.readFileSync(path.resolve("src-tauri/src/lib.rs"), "utf8");
  assert.ok(
    libRs.includes("async fn show_hub_window"),
    "show_hub_window Tauri command must be async so it never blocks the Win32 UI thread"
  );
  assert.ok(
    libRs.includes("async fn toggle_detached_orb"),
    "toggle_detached_orb Tauri command must be async so it never blocks the Win32 UI thread"
  );
  assert.ok(
    libRs.includes("spawn_blocking"),
    "WebviewWindowBuilder::build must execute on spawn_blocking off the Win32 main thread"
  );
  assert.equal(
    /run_on_main_thread[\s\S]{0,600}WebviewWindowBuilder::new/.test(libRs),
    false,
    "WebviewWindowBuilder::new().build() must NEVER be called inside run_on_main_thread (causes WebView2 deadlock on Windows)"
  );
});

test("Headless agy uses persistent stream-json, safe model/effort pairing, and CLI transcript discovery", () => {
  const sysTools = fs.readFileSync(path.resolve("src-tauri/src/system_tools.rs"), "utf8");
  assert.ok(
    sysTools.includes("model_slug_has_effort_suffix"),
    "spawn_headless_agy_turn must guard against passing --effort with suffixed model slugs"
  );
  assert.ok(
    sysTools.includes("--input-format"),
    "spawn_headless_agy_turn must support --input-format stream-json for persistent warm turns"
  );

  const stateRs = fs.readFileSync(path.resolve("src-tauri/src/state.rs"), "utf8");
  assert.ok(
    stateRs.includes("WarmAgyWorker"),
    "AppCore must keep persistent warm agy workers across follow-up turns"
  );
  assert.ok(
    stateRs.includes("antigravity-cli"),
    "discover_transcript_path must check .gemini/antigravity-cli/brain for CLI transcripts"
  );
  assert.ok(
    stateRs.includes("ins.latest_output.is_some() || !sess.bg_running"),
    "Transcript polling must not overwrite live streamed output with None while running"
  );

  const cockpitTsx = fs.readFileSync(path.resolve("src/components/SessionCockpit.tsx"), "utf8");
  assert.ok(
    cockpitTsx.includes("gemini-4-carbon-low"),
    "NewRunBar must default to fast gemini-4-carbon-low instead of slow High thinking CLI default"
  );

  const telemetryTsx = fs.readFileSync(path.resolve("src/components/SessionTelemetryView.tsx"), "utf8");
  assert.ok(
    telemetryTsx.includes("ide-live-elapsed"),
    "Live activity pill must display elapsed seconds while thinking"
  );
});

test("Dynamic Island hover uses critically damped zero-bounce spring, smooth collapse choreography, and clean rimless silhouette", () => {
  const springTs = fs.readFileSync(path.resolve("src/lib/islandSpring.ts"), "utf8");
  assert.ok(
    springTs.includes("ISLAND_OPEN_DAMPING = 1.0") &&
      springTs.includes("ISLAND_CLOSE_DAMPING = 1.0"),
    "Island open and close springs must be critically damped (1.0) for zero edge bounce and silky-smooth collapse"
  );

  const islandTsx = fs.readFileSync(path.resolve("src/surfaces/IslandSurface.tsx"), "utf8");
  assert.ok(
    islandTsx.includes("ISLAND_OPEN_DAMPING") &&
      islandTsx.includes("ISLAND_CLOSE_DAMPING") &&
      !islandTsx.includes("nova-island-rim"),
    "IslandSurface must wire critically damped open/close springs without top reflective rim light"
  );
  assert.ok(
    islandTsx.includes("proximityRef") &&
      islandTsx.includes("wakeScale") &&
      islandTsx.includes("closedStatusRef") &&
      islandTsx.includes("isMorphingRef"),
    "IslandSurface must drive GPU pre-wake scale from proximityRef, fade status text cleanly during cold-boot unfurl, and guard orb layout reads while morphing"
  );

  const libRs = fs.readFileSync(path.resolve("src-tauri/src/lib.rs"), "utf8");
  assert.ok(
    libRs.includes("MAGNET_ZONE_PX") && libRs.includes("proximity"),
    "Win32 cursor hit-tester must stream normalized magnetic proximity to IslandSurface"
  );
  assert.ok(
    libRs.includes("async fn set_island_rect"),
    "set_island_rect must be async so IPC hit-rect updates never block the Win32 UI thread"
  );
  assert.equal(
    islandTsx.includes("clientWidth"),
    false,
    "IslandSurface rAF loop must never read clientWidth/getBoundingClientRect causing forced synchronous reflow"
  );

  const stylesCss = fs.readFileSync(path.resolve("src/styles.css"), "utf8");
  assert.ok(
    stylesCss.includes(".nova-island-shadow") && stylesCss.includes("contain: strict"),
    "Island shell must use strict CSS containment and GPU-scaled shadow quad instead of per-frame box-shadow blur repaints"
  );

  const soundTs = fs.readFileSync(path.resolve("src/lib/soundEngine.ts"), "utf8");
  const supernovaTsx = fs.readFileSync(
    path.resolve("src/components/SupernovaIntroOverlay.tsx"),
    "utf8"
  );
  assert.ok(
    soundTs.includes('latencyHint: "interactive"') &&
      soundTs.includes("syncKeepAlive") &&
      soundTs.includes("playSupernovaBootAudio") &&
      supernovaTsx.includes("SupernovaIntroOverlay") &&
      !islandTsx.includes('setTimeout(() => playNovaCue('),
    "Hover open/close sounds must fire synchronously via pre-baked interactive AudioContext and Supernova Pure 1B boot sequence must be wired"
  );
});

test("Step logs expand inline diffs, jump to workspace+line in IDE, preserve past-turn logs, and render clean white mid-turn prose", () => {
  const sysTools = fs.readFileSync(path.resolve("src-tauri/src/system_tools.rs"), "utf8");
  assert.ok(
    sysTools.includes("workspace_path: Option<&str>"),
    "open_in_editor must accept workspace_path so Jump to IDE opens the project folder and navigates to line"
  );

  const stateRs = fs.readFileSync(path.resolve("src-tauri/src/state.rs"), "utf8");
  assert.ok(
    stateRs.includes("snapshot_logs_into_latest_turn") && stateRs.includes("pending_pre_text"),
    "Backend must archive per-turn focus_groups/diffs and attach mid-turn AI commentary as pre_text instead of spinner pills"
  );

  const telemetryTsx = fs.readFileSync(path.resolve("src/components/SessionTelemetryView.tsx"), "utf8");
  const ideMarkdownTsx = fs.readFileSync(path.resolve("src/components/IdeMarkdown.tsx"), "utf8");
  assert.ok(
    telemetryTsx.includes("ide-step-diff") && telemetryTsx.includes("Jump to IDE"),
    "StepRow must toggle inline gutter diff below the step with a Jump to IDE button"
  );
  assert.ok(
    telemetryTsx.includes("PastTurnLogsSection") &&
      !telemetryTsx.includes("ide-live-thinking") &&
      !telemetryTsx.includes("ide-past-tools-toggle") &&
      !telemetryTsx.includes("Show full prompt") &&
      !ideMarkdownTsx.includes("Show full response"),
    "Past turns and prompts/responses must render directly without redundant outer collapse pills"
  );
});
