import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

test("Generative UI <agent-embed> support enforces sandboxed CSP and ticketed frame endpoint", () => {
  const tauriConf = JSON.parse(
    fs.readFileSync(path.resolve("src-tauri/tauri.conf.json"), "utf8")
  );
  const csp = tauriConf.app.security.csp;
  assert.match(csp, /script-src 'self'/, "Main window must keep strict script-src 'self'");
  assert.match(
    csp,
    /frame-src 'self' http:\/\/127\.0\.0\.1:47920 http:\/\/localhost:1420/,
    "Main window CSP must allow framing the local NOVA embed-frame endpoint"
  );

  const serverRs = fs.readFileSync(path.resolve("src-tauri/src/server.rs"), "utf8");
  assert.match(serverRs, /\/workspace\/embed-ticket/);
  assert.match(serverRs, /\/workspace\/embed-frame/);
  assert.match(
    serverRs,
    /sandbox allow-scripts;[\s\S]*https:\/\/www\.gstatic\.com[\s\S]*connect-src 'none'/,
    "Embed frame response must enforce sandbox allow-scripts, allow gstatic Tailwind, and block connect-src"
  );

  const widgetTsx = fs.readFileSync(
    path.resolve("src/components/AgentEmbedWidget.tsx"),
    "utf8"
  );
  assert.match(widgetTsx, /sandbox="allow-scripts"/);
  assert.doesNotMatch(
    widgetTsx,
    /allow-same-origin/,
    "Iframe sandbox must never grant allow-same-origin"
  );

  const mdTsx = fs.readFileSync(path.resolve("src/components/IdeMarkdown.tsx"), "utf8");
  assert.match(mdTsx, /isValidLiveEmbedSrc/);
  assert.doesNotMatch(
    mdTsx,
    /splitAgentEmbedSegments/,
    "Must never split inline backtick code mentioning <agent-embed> across lines"
  );
  assert.doesNotMatch(
    mdTsx,
    /fenceEmbedMatch/,
    "Must never turn fenced code block examples into live embeds"
  );
});
