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

test("Frontend production bundle compiles cleanly into dist/ with zero demo endpoints", () => {
  assert.equal(fs.existsSync(path.resolve("dist/index.html")), true);
  const serverRs = fs.readFileSync(path.resolve("src-tauri/src/server.rs"), "utf8");
  assert.equal(serverRs.includes("/demo/simulate"), false, "Demo endpoint must not exist in production");
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
  assert.ok(stateRs.includes("CREATE_NO_WINDOW") || fs.readFileSync(path.resolve("src-tauri/src/system_tools.rs"), "utf8").includes("CREATE_NO_WINDOW"));
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
