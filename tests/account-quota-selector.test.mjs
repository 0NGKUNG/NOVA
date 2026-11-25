import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

test("Account switcher and quota routes are registered in server.rs and models", () => {
  const serverRs = fs.readFileSync(path.resolve("src-tauri/src/server.rs"), "utf8");
  assert.ok(serverRs.includes("/account/switch"), "Missing /account/switch route");
  assert.ok(serverRs.includes("/quota"), "Missing /quota route");
  assert.ok(serverRs.includes("/quota/refresh"), "Missing /quota/refresh route");

  const modelsRs = fs.readFileSync(path.resolve("src-tauri/src/models.rs"), "utf8");
  assert.ok(modelsRs.includes("pub struct AccountQuotaInfo"), "Missing AccountQuotaInfo in models.rs");
  assert.ok(modelsRs.includes("pub struct RealtimeQuotaState"), "Missing RealtimeQuotaState in models.rs");
  assert.ok(modelsRs.includes("gemini_second: bool"), "Missing gemini_second in SecretPresenceMap");
  assert.ok(modelsRs.includes("active_account"), "Missing active_account in NovaSettings");
});

test("Dual-account AI key resolution and quota tracking exist in ai_services and state", () => {
  const aiRs = fs.readFileSync(path.resolve("src-tauri/src/ai_services.rs"), "utf8");
  assert.ok(aiRs.includes("get_gemini_key_for_account"), "Missing get_gemini_key_for_account helper");
  assert.ok(aiRs.includes("probe_gemini_quota"), "Missing probe_gemini_quota helper");
  assert.ok(aiRs.includes("gemini_second"), "Missing gemini_second secret handling");

  const stateRs = fs.readFileSync(path.resolve("src-tauri/src/state.rs"), "utf8");
  assert.ok(stateRs.includes("QuotaTracker"), "Missing QuotaTracker in state.rs");
  assert.ok(stateRs.includes("compute_quota_state"), "Missing compute_quota_state in state.rs");
  assert.ok(stateRs.includes("record_ai_request"), "Missing record_ai_request in state.rs");
});

test("Frontend types and UI components implement direct account switch, quota gauge, and model selector", () => {
  const typesTs = fs.readFileSync(path.resolve("src/types.ts"), "utf8");
  assert.ok(typesTs.includes("AVAILABLE_MODELS"), "Missing AVAILABLE_MODELS export in types.ts");
  assert.ok(typesTs.includes("gemini-3.8-flash-high"), "Missing gemini 3.8 flash in model list");
  assert.ok(typesTs.includes("geminiSecond: boolean"), "Missing geminiSecond in SecretPresenceMap");
  assert.ok(typesTs.includes("RealtimeQuotaState"), "Missing RealtimeQuotaState interface");

  const clientTs = fs.readFileSync(path.resolve("src/lib/novaClient.ts"), "utf8");
  assert.ok(clientTs.includes("switchAccount:"), "Missing switchAccount in novaClient");
  assert.ok(clientTs.includes("refreshQuota:"), "Missing refreshQuota in novaClient");

  const islandTsx = fs.readFileSync(path.resolve("src/surfaces/IslandSurface.tsx"), "utf8");
  assert.ok(islandTsx.includes("nova-account-pill"), "Missing nova-account-pill in IslandSurface");
  assert.ok(islandTsx.includes("nova-quota-pill"), "Missing nova-quota-pill in IslandSurface");
  assert.ok(islandTsx.includes("nova-model-picker-wrap"), "Missing nova-model-picker-wrap in IslandSurface");
  assert.ok(islandTsx.includes("nova-quota-popover"), "Missing nova-quota-popover in IslandSurface");

  const hubTsx = fs.readFileSync(path.resolve("src/surfaces/HubSurface.tsx"), "utf8");
  assert.ok(hubTsx.includes("Dual Account & Real-Time Quota Manager"), "Missing Quota Manager in HubSurface");
  assert.ok(hubTsx.includes("gemini_second"), "Missing gemini_second key in HubSurface");
});
