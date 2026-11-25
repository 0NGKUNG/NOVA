import React, { useMemo, useState } from "react";
import {
  Activity,
  AlertTriangle,
  BarChart3,
  Check,
  Copy,
  Cpu,
  Download,
  ExternalLink,
  FileText,
  FolderGit2,
  Gauge,
  Github,
  KeyRound,
  Languages,
  Layers,
  Mic,
  Palette,
  Plus,
  QrCode,
  RefreshCw,
  Search,
  Shield,
  Smartphone,
  Sparkles,
  Trash2,
  User,
  Wrench,
} from "lucide-react";
import {
  AVAILABLE_MODELS,
  GitHubOverview,
  HardwareTelemetry,
  MediaStatus,
  NovaSnapshot,
  PortProcessInfo,
} from "../types";
import { Lang, t } from "../i18n";
import { isTauriRuntime, novaApi } from "../lib/novaClient";
import { NovaOrb } from "../components/NovaOrb";
import { ApprovalCard } from "../components/ApprovalCard";
import { DiffViewer } from "../components/DiffViewer";
import { getPhaseLabel, SessionTelemetryView } from "../components/SessionTelemetryView";
import { NewRunBar, PermissionPill, SessionCockpit } from "../components/SessionCockpit";
import { VoiceRecorderPanel } from "../components/VoiceRecorderPanel";
import { IslandSurface } from "./IslandSurface";

interface HubSurfaceProps {
  snapshot: NovaSnapshot;
  telemetry: HardwareTelemetry | null;
  ports: PortProcessInfo[];
  media: MediaStatus | null;
  github: GitHubOverview | null;
  onRefreshSystem: () => void;
}

type HubSection =
  | "mission"
  | "hooks"
  | "ai"
  | "voice"
  | "notes"
  | "devtools"
  | "recap"
  | "mobile"
  | "appearance";

export const HubSurface: React.FC<HubSurfaceProps> = ({
  snapshot,
  telemetry,
  ports,
  media,
  github,
  onRefreshSystem,
}) => {
  const { settings, agyHooks, secrets, analytics, mobile } = snapshot;
  const lang: Lang = settings.language;

  const [section, setSection] = useState<HubSection>("mission");
  const [sidebarSearch, setSidebarSearch] = useState("");
  const [showIslandPreview, setShowIslandPreview] = useState(!isTauriRuntime());

  // Secret inputs
  const [secretInputs, setSecretInputs] = useState<Record<string, string>>({});
  const [hookNotice, setHookNotice] = useState<string | null>(null);

  // Dual Account & Quota State
  const [mainAccountNameInput, setMainAccountNameInput] = useState(
    settings.mainAccountName || "Main Account"
  );
  const [secondAccountNameInput, setSecondAccountNameInput] = useState(
    settings.secondAccountName || "Second Account"
  );
  const [quotaRefreshing, setQuotaRefreshing] = useState(false);

  const handleSaveAccountNames = async () => {
    await novaApi.saveSettings({
      ...settings,
      mainAccountName: mainAccountNameInput.trim() || "Main Account",
      secondAccountName: secondAccountNameInput.trim() || "Second Account",
    });
  };

  const handleSwitchAccount = async (target: "main" | "second") => {
    await novaApi.switchAccount(target);
  };

  const handleRefreshQuota = async () => {
    setQuotaRefreshing(true);
    try {
      await novaApi.refreshQuota();
    } finally {
      setQuotaRefreshing(false);
    }
  };

  // Rule creator
  const [rulePattern, setRulePattern] = useState("");
  const [ruleTool, setRuleTool] = useState("run_command");
  const [ruleAction, setRuleAction] = useState<"allow" | "deny">("allow");
  const [ruleScope, setRuleScope] = useState<"global" | "workspace">("global");

  // Dictionary & Snippets editors
  const [newSpoken, setNewSpoken] = useState("");
  const [newCanonical, setNewCanonical] = useState("");
  const [newTrigger, setNewTrigger] = useState("");
  const [newExpansion, setNewExpansion] = useState("");

  // Recap Markdown preview
  const [devlogMd, setDevlogMd] = useState<string>("");

  const navItems: Array<{ id: HubSection; label: string; keywords: string; icon: React.ReactNode }> = [
    {
      id: "mission",
      label: t(lang, "missionControl"),
      keywords: "sessions workspaces subagents diffs approvals",
      icon: <Layers size={16} />,
    },
    {
      id: "hooks",
      label: t(lang, "hooksAndRules"),
      keywords: "antigravity hooks.json backup rules auto-approve risk",
      icon: <Shield size={16} />,
    },
    {
      id: "ai",
      label: t(lang, "aiAndKeys"),
      keywords: "gemini anthropic claude openai groq openrouter ollama credential keys",
      icon: <KeyRound size={16} />,
    },
    {
      id: "voice",
      label: t(lang, "bilingualVoice"),
      keywords: "dictation thai english whisper speech dictionary snippets",
      icon: <Mic size={16} />,
    },
    {
      id: "notes",
      label: t(lang, "meetingNotetaker"),
      keywords: "meeting voice memo summary action items todos",
      icon: <FileText size={16} />,
    },
    {
      id: "devtools",
      label: t(lang, "devTools"),
      keywords: "ports localhost kill cpu gpu ram media spotify github",
      icon: <Wrench size={16} />,
    },
    {
      id: "recap",
      label: t(lang, "recapInsights"),
      keywords: "analytics weekly recap devlog markdown share png",
      icon: <BarChart3 size={16} />,
    },
    {
      id: "mobile",
      label: t(lang, "mobileAndRemote"),
      keywords: "qr pwa phone android iphone tailscale telegram bot",
      icon: <Smartphone size={16} />,
    },
    {
      id: "appearance",
      label: t(lang, "appearanceShortcuts"),
      keywords: "theme obsidian acrylic tactical aura orb hud snap zones shortcuts altgr",
      icon: <Palette size={16} />,
    },
  ];

  const filteredNav = useMemo(() => {
    const q = sidebarSearch.trim().toLowerCase();
    if (!q) return navItems;
    return navItems.filter(
      (n) => n.label.toLowerCase().includes(q) || n.keywords.includes(q)
    );
  }, [sidebarSearch, lang]);

  const handleSaveSecret = async (slot: string) => {
    const val = secretInputs[slot] ?? "";
    const res = await novaApi.setSecret(slot, val);
    if (res.ok) {
      setSecretInputs((prev) => ({ ...prev, [slot]: "" }));
      onRefreshSystem();
    }
  };

  const downloadShareableRecapPng = () => {
    const canvas = document.createElement("canvas");
    canvas.width = 1080;
    canvas.height = 1920;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const grad = ctx.createLinearGradient(0, 0, 1080, 1920);
    grad.addColorStop(0, "#050811");
    grad.addColorStop(0.5, "#0d162c");
    grad.addColorStop(1, "#070b14");
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 1080, 1920);

    // Orbital glow
    const rad = ctx.createRadialGradient(540, 380, 30, 540, 380, 340);
    rad.addColorStop(0, "rgba(34, 211, 238, 0.48)");
    rad.addColorStop(1, "rgba(34, 211, 238, 0)");
    ctx.fillStyle = rad;
    ctx.beginPath();
    ctx.arc(540, 380, 340, 0, Math.PI * 2);
    ctx.fill();

    ctx.strokeStyle = "#22d3ee";
    ctx.lineWidth = 6;
    ctx.beginPath();
    ctx.arc(540, 380, 110, 0, Math.PI * 2);
    ctx.stroke();

    ctx.fillStyle = "#ffffff";
    ctx.font = "bold 76px Segoe UI, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("NOVA MISSION RECAP", 540, 610);

    ctx.fillStyle = "#94a3b8";
    ctx.font = "34px Segoe UI, sans-serif";
    ctx.fillText(new Date().toLocaleDateString(), 540, 675);

    const stats = [
      ["Agent Sessions", String(analytics.totalSessions)],
      ["Commands Inspected", String(analytics.totalCommandsInspected)],
      ["Files Edited", `${analytics.filesEdited} (+${analytics.linesAdded} / -${analytics.linesRemoved})`],
      ["Focus Minutes", `${analytics.focusMinutes} min`],
      ["Voice Dictations", `${analytics.dictationsCount} (${analytics.dictatedWords} words)`],
    ];

    let y = 820;
    ctx.textAlign = "left";
    for (const [label, value] of stats) {
      ctx.fillStyle = "rgba(15, 23, 42, 0.85)";
      ctx.strokeStyle = "rgba(56, 189, 248, 0.28)";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.roundRect(110, y, 860, 145, 24);
      ctx.fill();
      ctx.stroke();

      ctx.fillStyle = "#94a3b8";
      ctx.font = "32px Segoe UI, sans-serif";
      ctx.fillText(label, 160, y + 60);

      ctx.fillStyle = "#f8fafc";
      ctx.font = "bold 46px Segoe UI, sans-serif";
      ctx.fillText(value, 160, y + 116);
      y += 180;
    }

    const link = document.createElement("a");
    link.download = `NOVA-Recap-${new Date().toISOString().slice(0, 10)}.png`;
    link.href = canvas.toDataURL("image/png");
    link.click();
  };

  return (
    <div className={`nova-hub-shell theme-${settings.theme} aura-${settings.aura}`}>
      {/* Interactive Top Dynamic Island Live Preview Dock (great for browser inspection & live testing!) */}
      {showIslandPreview && (
        <div className="hub-island-preview-dock">
          <div className="dock-caption">
            <span>Live Interactive Dynamic Island Surface</span>
            <button
              className="nova-btn nova-btn-ghost nova-btn-xs"
              onClick={() => setShowIslandPreview(false)}
            >
              Hide Preview Dock
            </button>
          </div>
          <IslandSurface
            snapshot={snapshot}
            telemetry={telemetry}
            ports={ports}
            media={media}
            github={github}
            onRefreshSystem={onRefreshSystem}
            embeddedPreview
          />
        </div>
      )}

      <div className="nova-hub-frame">
        {/* LEFT SIDEBAR */}
        <aside className="nova-hub-sidebar">
          <div className="hub-brand-row">
            <NovaOrb
              mode={settings.avatarMode}
              aura={settings.aura}
              state={snapshot.pendingApprovals.length > 0 ? "alert" : "active"}
              size={38}
            />
            <div>
              <div className="nova-logo-text">NOVA</div>
              <div className="muted-note">v{snapshot.version} · Windows Edition</div>
            </div>
          </div>

          <div className="hub-search-box">
            <Search size={14} />
            <input
              placeholder="Search settings & tools..."
              value={sidebarSearch}
              onChange={(e) => setSidebarSearch(e.target.value)}
            />
          </div>

          <nav className="hub-nav-list">
            {filteredNav.map((item) => (
              <button
                key={item.id}
                className={`hub-nav-btn ${section === item.id ? "active" : ""}`}
                onClick={() => setSection(item.id)}
              >
                {item.icon}
                <span>{item.label}</span>
              </button>
            ))}
          </nav>

          <div className="hub-sidebar-footer">
            <button
              className="nova-btn nova-btn-ghost nova-btn-xs"
              onClick={() =>
                novaApi.saveSettings({
                  ...settings,
                  language: settings.language === "en" ? "th" : "en",
                })
              }
            >
              <Languages size={13} />
              <span>{settings.language === "en" ? "Switch to ภาษาไทย" : "Switch to English"}</span>
            </button>

            {!showIslandPreview && (
              <button
                className="nova-btn nova-btn-ghost nova-btn-xs"
                onClick={() => setShowIslandPreview(true)}
              >
                Show Island Dock
              </button>
            )}
          </div>
        </aside>

        {/* MAIN HUB CONTENT */}
        <main className="nova-hub-main">
          {/* 1. MISSION CONTROL */}
          {section === "mission" && (
            <div className="hub-section">
              <div className="nova-row-between">
                <div>
                  <h2>{t(lang, "missionControl")}</h2>
                  <p className="muted-note">{t(lang, "missionDescription")}</p>
                </div>
                <PermissionPill snapshot={snapshot} session={null} />
              </div>

              <div className="hub-card">
                <NewRunBar snapshot={snapshot} lang={lang} />
              </div>

              {snapshot.pendingApprovals.length > 0 && (
                <div className="hub-stack">
                  <h3>Waiting Approvals ({snapshot.pendingApprovals.length})</h3>
                  {snapshot.pendingApprovals.map((a) => (
                    <ApprovalCard key={a.id} approval={a} lang={lang} />
                  ))}
                </div>
              )}

              {snapshot.sessions.length === 0 ? (
                <section className="hub-empty-state" aria-labelledby="hub-empty-title">
                  <div className="hub-empty-orb-frame">
                    <NovaOrb mode="orb" aura={settings.aura} state="idle" size={76} />
                  </div>
                  <div className="hub-empty-copy">
                    <div className="hub-empty-status">
                      <span className="hub-empty-status-dot" /> {t(lang, "readyWhenYouAre")}
                    </div>
                    <h3 id="hub-empty-title">{t(lang, "nothingRunning")}</h3>
                    <p>{t(lang, "connectAntigravityHint")}</p>
                  </div>
                  <div className="hub-empty-actions">
                    <button className="nova-btn nova-btn-primary" onClick={() => setSection("hooks")}>
                      <Wrench size={15} /> {t(lang, "setupAntigravity")}
                    </button>
                  </div>
                </section>
              ) : (
                <div className="hub-grid-2">
                  {snapshot.sessions.map((s) => {
                    const ph = getPhaseLabel(s, lang);
                    return (
                      <div key={s.conversationId} className="hub-card">
                        <div className="nova-row-between">
                          <div className="nova-row-gap">
                            <FolderGit2 size={16} />
                            <strong>{s.workspaceName}</strong>
                            {s.gitBranch && <span className="workspace-chip">{s.gitBranch}</span>}
                            {s.modelName && <span className="model-tag">{s.modelName}</span>}
                          </div>
                          <span className={`phase-pill phase-${ph.key}`}>{ph.label}</span>
                        </div>
                        <p className="muted-note">{s.workspacePath}</p>
                        <SessionTelemetryView session={s} lang={lang} />
                        <SessionCockpit snapshot={snapshot} session={s} lang={lang} />
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {/* 2. ANTIGRAVITY HOOKS & SMART APPROVAL RULES */}
          {section === "hooks" && (
            <div className="hub-section">
              <h2>{t(lang, "hooksAndRules")}</h2>
              <p className="muted-note">
                NOVA safely merges a <code>"nova"</code> hook group into{" "}
                <code>{agyHooks.hooksJsonPath}</code> with a dated backup—never clobbering existing hooks.
              </p>

              <div className="hub-card">
                <div className="nova-row-between">
                  <div>
                    <strong>Antigravity Hook Status: </strong>
                    <span className={agyHooks.novaInstalled ? "badge-ok" : "badge-warn"}>
                      {agyHooks.novaInstalled ? "Installed & Active" : "Not Installed Yet"}
                    </span>
                    {agyHooks.coucouDetected && (
                      <span className="workspace-chip" style={{ marginLeft: 8 }}>
                        Coucou Hook Detected ({agyHooks.coucouEnabled ? "Enabled" : "Paused"})
                      </span>
                    )}
                  </div>
                  <div className="nova-btn-group">
                    <button
                      className="nova-btn nova-btn-primary"
                      onClick={async () => {
                        const r = await novaApi.applyAntigravityHooks("install");
                        setHookNotice(
                          r.ok
                            ? `Installed NOVA hooks! Backup saved at ${r.backupPath ?? "config dir"}`
                            : r.error || "Failed"
                        );
                      }}
                    >
                      <Check size={14} />
                      <span>{agyHooks.novaInstalled ? "Refresh NOVA Hooks" : "Install NOVA Hooks"}</span>
                    </button>

                    {agyHooks.novaInstalled && (
                      <button
                        className="nova-btn nova-btn-deny"
                        onClick={async () => {
                          const r = await novaApi.applyAntigravityHooks("uninstall");
                          setHookNotice(r.ok ? "Removed NOVA hooks cleanly." : r.error || "Failed");
                        }}
                      >
                        Uninstall NOVA Hooks
                      </button>
                    )}

                    {agyHooks.coucouDetected && (
                      <button
                        className="nova-btn nova-btn-ghost"
                        onClick={() =>
                          novaApi.applyAntigravityHooks(
                            agyHooks.coucouEnabled ? "disable_coucou" : "enable_coucou"
                          )
                        }
                      >
                        {agyHooks.coucouEnabled ? "Pause Old Coucou Hook" : "Re-enable Coucou Hook"}
                      </button>
                    )}
                  </div>
                </div>

                {hookNotice && <div className="nova-status-hint">{hookNotice}</div>}

                <div className="hub-toggle-grid" style={{ marginTop: 12 }}>
                  <label className="nova-checkbox-label">
                    <input
                      type="checkbox"
                      checked={settings.agyApproveInIsland}
                      onChange={(e) =>
                        novaApi.saveSettings({
                          ...settings,
                          agyApproveInIsland: e.target.checked,
                        })
                      }
                    />
                    <span>Approve Antigravity shell commands & high-risk edits inside NOVA Island</span>
                  </label>

                  <label className="nova-checkbox-label">
                    <input
                      type="checkbox"
                      checked={settings.autoApproveSafeReads}
                      onChange={(e) =>
                        novaApi.saveSettings({
                          ...settings,
                          autoApproveSafeReads: e.target.checked,
                        })
                      }
                    />
                    <span>Auto-approve verified read-only & local test commands (`git status`, `npm test`, `cargo check`)</span>
                  </label>
                </div>

                <details style={{ marginTop: 12 }}>
                  <summary className="clickable muted-note">
                    Preview exact unified diff for <code>hooks.json</code>
                  </summary>
                  <pre className="nova-diff-pre" style={{ marginTop: 8 }}>
                    {agyHooks.diffPreview}
                  </pre>
                </details>
              </div>

              <div className="hub-card">
                <h3>Custom Scoped Approval Rules ({snapshot.approvalRules.length})</h3>
                <div className="nova-row-gap" style={{ marginBottom: 12 }}>
                  <select
                    className="nova-select"
                    value={ruleAction}
                    onChange={(e) => setRuleAction(e.target.value as "allow" | "deny")}
                  >
                    <option value="allow">Allow</option>
                    <option value="deny">Block / Deny</option>
                  </select>
                  <select
                    className="nova-select"
                    value={ruleTool}
                    onChange={(e) => setRuleTool(e.target.value)}
                  >
                    <option value="run_command">run_command</option>
                    <option value="edit_file">edit_file</option>
                    <option value="*">Any Tool (*)</option>
                  </select>
                  <select
                    className="nova-select"
                    value={ruleScope}
                    onChange={(e) => setRuleScope(e.target.value as "global" | "workspace")}
                  >
                    <option value="global">Global</option>
                    <option value="workspace">Current Workspace</option>
                  </select>
                  <input
                    className="nova-input"
                    placeholder="Command prefix or pattern (e.g. npm run build)..."
                    value={rulePattern}
                    onChange={(e) => setRulePattern(e.target.value)}
                  />
                  <button
                    className="nova-btn nova-btn-rule"
                    onClick={() => {
                      if (!rulePattern.trim()) return;
                      novaApi.addRule({
                        action: ruleAction,
                        scope: ruleScope,
                        toolMatcher: ruleTool,
                        pattern: rulePattern.trim(),
                        label: `${ruleAction.toUpperCase()} "${rulePattern.trim()}"`,
                      });
                      setRulePattern("");
                    }}
                  >
                    <Plus size={14} /> Add Rule
                  </button>
                </div>

                {snapshot.approvalRules.map((r) => (
                  <div key={r.id} className="port-row">
                    <div>
                      <span className={r.action === "allow" ? "badge-ok" : "badge-warn"}>
                        {r.action.toUpperCase()}
                      </span>{" "}
                      <code>{r.pattern}</code>{" "}
                      <span className="muted-note">
                        ({r.toolMatcher} · {r.scope})
                      </span>
                    </div>
                    <button
                      className="nova-btn nova-btn-ghost nova-btn-xs"
                      onClick={() => novaApi.deleteRule(r.id)}
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* 3. AI PROVIDERS & CREDENTIAL MANAGER KEYS */}
          {section === "ai" && (
            <div className="hub-section">
              <h2>{t(lang, "aiAndKeys")}</h2>
              <p className="muted-note">
                All secrets are stored directly in <strong>Windows Credential Manager</strong> (`app.nova.missioncontrol`)—never written to JSON files on disk.
              </p>

              {/* DUAL ACCOUNT & REAL-TIME QUOTA CARD */}
              <div className="hub-card" style={{ marginBottom: 16 }}>
                <div className="nova-row-between">
                  <div>
                    <h3>{lang === "th" ? "จัดการบัญชีคู่ & โควตาเรียลไทม์" : "Dual Account & Real-Time Quota Manager"}</h3>
                    <p className="muted-note">
                      {lang === "th"
                        ? "สลับบัญชีหลักและบัญชีสำรองได้ทันที พร้อมตรวจวัด RPM, RPD, TPM แบบสดเพื่อเลี่ยงข้อจำกัด 429"
                        : "Directly toggle Main and Second accounts with live RPM, RPD, and TPM meters to avoid rate limits."}
                    </p>
                  </div>
                  <button
                    type="button"
                    className={`nova-btn nova-btn-ghost nova-btn-xs ${quotaRefreshing ? "spinning" : ""}`}
                    onClick={handleRefreshQuota}
                  >
                    <RefreshCw size={12} />
                    <span>{quotaRefreshing ? "Probing..." : "Refresh Quota"}</span>
                  </button>
                </div>

                {/* Active Account Switcher Tabs & Names */}
                <div className="hub-account-switch-row" style={{ marginTop: 12 }}>
                  <div className="account-switch-pill-group">
                    <button
                      type="button"
                      className={`account-switch-btn ${settings.activeAccount !== "second" ? "active" : ""}`}
                      onClick={() => handleSwitchAccount("main")}
                    >
                      <User size={13} />
                      <span>{settings.mainAccountName || "Main Account"}</span>
                      {settings.activeAccount !== "second" && <span className="active-glow-tag">ACTIVE</span>}
                    </button>
                    <button
                      type="button"
                      className={`account-switch-btn ${settings.activeAccount === "second" ? "active" : ""}`}
                      onClick={() => handleSwitchAccount("second")}
                    >
                      <User size={13} />
                      <span>{settings.secondAccountName || "Second Account"}</span>
                      {settings.activeAccount === "second" && <span className="active-glow-tag">ACTIVE</span>}
                    </button>
                  </div>

                  <div className="account-name-inputs">
                    <input
                      className="nova-input nova-input-sm"
                      placeholder="Main Account Label..."
                      value={mainAccountNameInput}
                      onChange={(e) => setMainAccountNameInput(e.target.value)}
                    />
                    <input
                      className="nova-input nova-input-sm"
                      placeholder="Second Account Label..."
                      value={secondAccountNameInput}
                      onChange={(e) => setSecondAccountNameInput(e.target.value)}
                    />
                    <button
                      type="button"
                      className="nova-btn nova-btn-primary nova-btn-xs"
                      onClick={handleSaveAccountNames}
                    >
                      Save Names
                    </button>
                  </div>
                </div>

                {/* Default AI Model Selector */}
                <div className="hub-model-selector-bar" style={{ marginTop: 14 }}>
                  <span className="muted-note" style={{ marginRight: 8 }}>Default AI Model:</span>
                  <select
                    className="nova-select"
                    value={settings.defaultChatModel}
                    onChange={(e) => {
                      const found = AVAILABLE_MODELS.find((m) => m.id === e.target.value);
                      novaApi.saveSettings({
                        ...settings,
                        defaultChatModel: e.target.value,
                        defaultChatProvider: found ? found.provider : settings.defaultChatProvider,
                      });
                    }}
                  >
                    {AVAILABLE_MODELS.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.name} ({m.provider.toUpperCase()})
                      </option>
                    ))}
                  </select>
                </div>

                {/* Side-by-Side Live Quota Cards */}
                <div className="hub-grid-2" style={{ marginTop: 16 }}>
                  {/* MAIN ACCOUNT QUOTA */}
                  <div className={`hub-quota-card ${settings.activeAccount !== "second" ? "is-active" : ""}`}>
                    <div className="nova-row-between">
                      <div className="quota-card-title">
                        <strong>{settings.mainAccountName || "Main Account"}</strong>
                        <span className={`status-badge status-${snapshot.quota?.main.status || "healthy"}`}>
                          {snapshot.quota?.main.status || "healthy"}
                        </span>
                      </div>
                      {settings.activeAccount !== "second" ? (
                        <span className="active-pill-badge">Active</span>
                      ) : (
                        <button
                          type="button"
                          className="nova-btn nova-btn-ghost nova-btn-xs"
                          onClick={() => handleSwitchAccount("main")}
                        >
                          Switch Here
                        </button>
                      )}
                    </div>

                    <div className="quota-row-metric" style={{ marginTop: 10 }}>
                      <span className="metric-label">Requests / Min:</span>
                      <strong className="metric-val">
                        {snapshot.quota?.main.rpmUsed ?? 0} / {snapshot.quota?.main.rpmLimit ?? 15} RPM
                      </strong>
                    </div>
                    <div className="quota-bar-track">
                      <div
                        className={`quota-bar-fill status-${snapshot.quota?.main.status || "healthy"}`}
                        style={{ width: `${Math.min(100, snapshot.quota?.main.percentageUsed ?? 0)}%` }}
                      />
                    </div>

                    <div className="quota-row-metric" style={{ marginTop: 8 }}>
                      <span className="metric-label">Requests / Day:</span>
                      <strong className="metric-val">
                        {snapshot.quota?.main.rpdUsed ?? 0} / {snapshot.quota?.main.rpdLimit ?? 1500} RPD
                      </strong>
                    </div>

                    <div className="quota-footer-details">
                      <span>Tokens Today: {(snapshot.quota?.main.totalTokensToday ?? 0).toLocaleString()}</span>
                      <span>Reset in: {snapshot.quota?.main.resetInSeconds ?? 0}s</span>
                    </div>
                  </div>

                  {/* SECOND ACCOUNT QUOTA */}
                  <div className={`hub-quota-card ${settings.activeAccount === "second" ? "is-active" : ""}`}>
                    <div className="nova-row-between">
                      <div className="quota-card-title">
                        <strong>{settings.secondAccountName || "Second Account"}</strong>
                        <span className={`status-badge status-${snapshot.quota?.second.status || "healthy"}`}>
                          {snapshot.quota?.second.status || "healthy"}
                        </span>
                      </div>
                      {settings.activeAccount === "second" ? (
                        <span className="active-pill-badge">Active</span>
                      ) : (
                        <button
                          type="button"
                          className="nova-btn nova-btn-ghost nova-btn-xs"
                          onClick={() => handleSwitchAccount("second")}
                        >
                          Switch Here
                        </button>
                      )}
                    </div>

                    <div className="quota-row-metric" style={{ marginTop: 10 }}>
                      <span className="metric-label">Requests / Min:</span>
                      <strong className="metric-val">
                        {snapshot.quota?.second.rpmUsed ?? 0} / {snapshot.quota?.second.rpmLimit ?? 15} RPM
                      </strong>
                    </div>
                    <div className="quota-bar-track">
                      <div
                        className={`quota-bar-fill status-${snapshot.quota?.second.status || "healthy"}`}
                        style={{ width: `${Math.min(100, snapshot.quota?.second.percentageUsed ?? 0)}%` }}
                      />
                    </div>

                    <div className="quota-row-metric" style={{ marginTop: 8 }}>
                      <span className="metric-label">Requests / Day:</span>
                      <strong className="metric-val">
                        {snapshot.quota?.second.rpdUsed ?? 0} / {snapshot.quota?.second.rpdLimit ?? 1500} RPD
                      </strong>
                    </div>

                    <div className="quota-footer-details">
                      <span>Tokens Today: {(snapshot.quota?.second.totalTokensToday ?? 0).toLocaleString()}</span>
                      <span>Reset in: {snapshot.quota?.second.resetInSeconds ?? 0}s</span>
                    </div>
                  </div>
                </div>
              </div>

              <div className="hub-grid-2">
                {(
                  [
                    ["gemini", "Google Gemini API Key (Main Account)", secrets.gemini],
                    ["gemini_second", "Google Gemini API Key (Second Account)", secrets.geminiSecond],
                    ["anthropic", "Anthropic Claude API Key", secrets.anthropic],
                    ["openai", "OpenAI API Key", secrets.openai],
                    ["groq", "Groq API Key (Fast Chat + Whisper STT)", secrets.groq],
                    ["openrouter", "OpenRouter API Key", secrets.openrouter],
                    ["github", "GitHub Personal Access Token (PRs & CI)", secrets.github],
                  ] as Array<[string, string, boolean]>
                ).map(([slot, title, present]) => (
                  <div key={slot} className="hub-card">
                    <div className="nova-row-between">
                      <strong>{title}</strong>
                      <span className={present ? "badge-ok" : "muted-note"}>
                        {present ? "Saved in Keyring" : "Not Set"}
                      </span>
                    </div>
                    <div className="nova-row-gap" style={{ marginTop: 8 }}>
                      <input
                        type="password"
                        className="nova-input"
                        placeholder={present ? "•••••••• (enter new to replace)" : "Paste key..."}
                        value={secretInputs[slot] ?? ""}
                        onChange={(e) =>
                          setSecretInputs((prev) => ({ ...prev, [slot]: e.target.value }))
                        }
                      />
                      <button
                        className="nova-btn nova-btn-primary nova-btn-xs"
                        onClick={() => handleSaveSecret(slot)}
                      >
                        Save
                      </button>
                      {present && (
                        <button
                          className="nova-btn nova-btn-ghost nova-btn-xs"
                          onClick={() => novaApi.setSecret(slot, "")}
                        >
                          Clear
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>

              <div className="hub-card">
                <h3>Local Model Endpoints (Ollama & LM Studio)</h3>
                <div className="hub-grid-2">
                  <div>
                    <label className="muted-note">Ollama Endpoint</label>
                    <input
                      className="nova-input"
                      value={settings.ollamaUrl}
                      onChange={(e) =>
                        novaApi.saveSettings({ ...settings, ollamaUrl: e.target.value })
                      }
                    />
                  </div>
                  <div>
                    <label className="muted-note">LM Studio Endpoint</label>
                    <input
                      className="nova-input"
                      value={settings.lmstudioUrl}
                      onChange={(e) =>
                        novaApi.saveSettings({ ...settings, lmstudioUrl: e.target.value })
                      }
                    />
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* 4. FLOW BILINGUAL VOICE, TECH DICTIONARY & SNIPPETS */}
          {section === "voice" && (
            <div className="hub-section">
              <h2>{t(lang, "bilingualVoice")}</h2>
              <p className="muted-note">
                Seamless Thai + English technical dictation (`แอนติกราวิตี้` → `Antigravity`), custom voice snippets, and hybrid STT.
              </p>

              <div className="hub-card">
                <div className="nova-row-between" style={{ marginBottom: 10 }}>
                  <strong>Preferred STT Engine</strong>
                  <select
                    className="nova-select"
                    value={settings.sttProvider}
                    onChange={(e) =>
                      novaApi.saveSettings({
                        ...settings,
                        sttProvider: e.target.value as NovaSnapshot["settings"]["sttProvider"],
                      })
                    }
                  >
                    <option value="groq">Groq Whisper Large v3 Turbo (Recommended)</option>
                    <option value="gemini">Gemini 2.5 Flash Multimodal Audio</option>
                    <option value="openai">OpenAI Whisper-1</option>
                    <option value="webspeech">Browser / Windows Native Web Speech (Zero Key)</option>
                  </select>
                </div>
                <VoiceRecorderPanel snapshot={snapshot} lang={lang} />
              </div>

              <div className="hub-grid-2">
                <div className="hub-card">
                  <h3>Bilingual Tech Dictionary ({snapshot.techDictionary.length})</h3>
                  <div className="nova-row-gap" style={{ marginBottom: 10 }}>
                    <input
                      className="nova-input nova-input-xs"
                      placeholder="Spoken (e.g. เน็กซ์เจเอส)"
                      value={newSpoken}
                      onChange={(e) => setNewSpoken(e.target.value)}
                    />
                    <input
                      className="nova-input nova-input-xs"
                      placeholder="Canonical (e.g. Next.js)"
                      value={newCanonical}
                      onChange={(e) => setNewCanonical(e.target.value)}
                    />
                    <button
                      className="nova-btn nova-btn-rule nova-btn-xs"
                      onClick={() => {
                        if (!newSpoken.trim() || !newCanonical.trim()) return;
                        novaApi.saveDictionary([
                          ...snapshot.techDictionary,
                          { spoken: newSpoken.trim(), canonical: newCanonical.trim() },
                        ]);
                        setNewSpoken("");
                        setNewCanonical("");
                      }}
                    >
                      <Plus size={13} />
                    </button>
                  </div>
                  {snapshot.techDictionary.map((term, idx) => (
                    <div key={idx} className="port-row">
                      <span>
                        “{term.spoken}” → <strong>{term.canonical}</strong>
                      </span>
                      <button
                        className="nova-btn-ghost nova-btn-xs"
                        onClick={() =>
                          novaApi.saveDictionary(
                            snapshot.techDictionary.filter((_, i) => i !== idx)
                          )
                        }
                      >
                        <Trash2 size={12} />
                      </button>
                    </div>
                  ))}
                </div>

                <div className="hub-card">
                  <h3>Voice Snippets ({snapshot.voiceSnippets.length})</h3>
                  <div className="nova-row-gap" style={{ marginBottom: 10 }}>
                    <input
                      className="nova-input nova-input-xs"
                      placeholder="Spoken trigger..."
                      value={newTrigger}
                      onChange={(e) => setNewTrigger(e.target.value)}
                    />
                    <input
                      className="nova-input nova-input-xs"
                      placeholder="Expanded text / command..."
                      value={newExpansion}
                      onChange={(e) => setNewExpansion(e.target.value)}
                    />
                    <button
                      className="nova-btn nova-btn-rule nova-btn-xs"
                      onClick={() => {
                        if (!newTrigger.trim() || !newExpansion.trim()) return;
                        novaApi.saveSnippets([
                          ...snapshot.voiceSnippets,
                          { trigger: newTrigger.trim(), expansion: newExpansion.trim() },
                        ]);
                        setNewTrigger("");
                        setNewExpansion("");
                      }}
                    >
                      <Plus size={13} />
                    </button>
                  </div>
                  {snapshot.voiceSnippets.map((sn, idx) => (
                    <div key={idx} className="port-row">
                      <span>
                        <strong>{sn.trigger}</strong> → <code>{sn.expansion}</code>
                      </span>
                      <button
                        className="nova-btn-ghost nova-btn-xs"
                        onClick={() =>
                          novaApi.saveSnippets(
                            snapshot.voiceSnippets.filter((_, i) => i !== idx)
                          )
                        }
                      >
                        <Trash2 size={12} />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* 5. MEETING & MEMO NOTETAKER */}
          {section === "notes" && (
            <div className="hub-section">
              <h2>{t(lang, "meetingNotetaker")}</h2>
              {snapshot.voiceNotes.length === 0 ? (
                <div className="nova-empty-card">
                  Record or paste a meeting/voice memo in Flow Bilingual Voice and click{" "}
                  <strong>Summarize & Save Note</strong> to build action-item notes here.
                </div>
              ) : (
                <div className="hub-stack">
                  {snapshot.voiceNotes.map((n) => (
                    <div key={n.id} className="hub-card">
                      <div className="nova-row-between">
                        <h3>{n.title}</h3>
                        <span className="muted-note">
                          {n.wordCount} words · {new Date(n.createdAt).toLocaleString()}
                        </span>
                      </div>
                      <p style={{ margin: "8px 0" }}>{n.summary}</p>
                      {n.actionItems.length > 0 && (
                        <div className="todo-mini-list">
                          {n.actionItems.map((act) => (
                            <label key={act.id} className="todo-row">
                              <input
                                type="checkbox"
                                checked={act.done}
                                onChange={() => novaApi.toggleVoiceNoteAction(n.id, act.id)}
                              />
                              <span className={act.done ? "todo-done" : ""}>{act.text}</span>
                            </label>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* 6. DEV UTILITIES: PORTS, HARDWARE, SCRATCHPAD, GITHUB */}
          {section === "devtools" && (
            <div className="hub-section">
              <div className="nova-row-between">
                <h2>{t(lang, "devTools")}</h2>
                <button className="nova-btn nova-btn-ghost" onClick={onRefreshSystem}>
                  <RefreshCw size={14} /> Refresh Live System State
                </button>
              </div>

              <div className="hub-grid-2">
                <div className="hub-card">
                  <h3>
                    <Cpu size={15} /> Live Hardware Load
                  </h3>
                  {telemetry && (
                    <>
                      <p className="muted-note">{telemetry.cpuBrand}</p>
                      <div className="port-row">
                        <span>CPU Load ({telemetry.coreCount} threads)</span>
                        <strong>{telemetry.cpuPercent.toFixed(1)}%</strong>
                      </div>
                      <div className="port-row">
                        <span>Memory Used</span>
                        <strong>
                          {telemetry.ramUsedGb.toFixed(2)} / {telemetry.ramTotalGb.toFixed(2)} GB (
                          {telemetry.ramPercent.toFixed(0)}%)
                        </strong>
                      </div>
                      {telemetry.gpu && (
                        <div className="port-row">
                          <span>{telemetry.gpu.name}</span>
                          <strong>
                            {telemetry.gpu.loadPercent}% · {telemetry.gpu.vramUsedMb} /{" "}
                            {telemetry.gpu.vramTotalMb} MB
                          </strong>
                        </div>
                      )}
                      <h4 style={{ marginTop: 12 }}>Top Memory Processes</h4>
                      {telemetry.topProcesses.slice(0, 5).map((tp) => (
                        <div key={tp.pid} className="port-row">
                          <span>
                            {tp.name} <span className="muted-note">(PID {tp.pid})</span>
                          </span>
                          <span>{tp.memoryMb} MB</span>
                        </div>
                      ))}
                    </>
                  )}
                </div>

                <div className="hub-card">
                  <h3>
                    <Activity size={15} /> Active Listening TCP Ports ({ports.length})
                  </h3>
                  <div className="nova-ports-list">
                    {ports.map((p) => (
                      <div key={p.port} className="port-row">
                        <div>
                          <span className="port-badge">:{p.port}</span>{" "}
                          <strong>{p.processName}</strong>{" "}
                          {p.frameworkHint && <span className="port-hint">{p.frameworkHint}</span>}
                        </div>
                        <div className="nova-btn-group">
                          <button
                            className="nova-btn nova-btn-ghost nova-btn-xs"
                            onClick={() => novaApi.openExternalUrl(`http://localhost:${p.port}`)}
                          >
                            <ExternalLink size={12} />
                          </button>
                          {p.port !== 47920 && (
                            <button
                              className="nova-btn nova-btn-deny nova-btn-xs"
                              onClick={async () => {
                                await novaApi.killPortPid(p.pid);
                                onRefreshSystem();
                              }}
                            >
                              Kill
                            </button>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>

              <div className="hub-card">
                <h3>Markdown Daily Scratchpad</h3>
                <textarea
                  className="nova-textarea"
                  rows={6}
                  value={snapshot.focus.scratchpadMarkdown}
                  onChange={(e) => novaApi.saveScratchpad(e.target.value)}
                />
              </div>
            </div>
          )}

          {/* 7. ANALYTICS & DEVLOG RECAP */}
          {section === "recap" && (
            <div className="hub-section">
              <div className="nova-row-between">
                <h2>{t(lang, "recapInsights")}</h2>
                <div className="nova-btn-group">
                  <button
                    className="nova-btn nova-btn-rule"
                    onClick={async () => {
                      const r = await novaApi.exportDevlogMarkdown();
                      if (r.ok) setDevlogMd(r.markdown);
                    }}
                  >
                    <FileText size={14} /> Generate Markdown Devlog
                  </button>
                  <button
                    className="nova-btn nova-btn-primary"
                    onClick={downloadShareableRecapPng}
                  >
                    <Download size={14} /> Download 1080×1920 Story PNG
                  </button>
                </div>
              </div>

              <div className="hub-stats-grid">
                <div className="stat-tile">
                  <span>Sessions</span>
                  <strong>{analytics.totalSessions}</strong>
                </div>
                <div className="stat-tile">
                  <span>Commands Checked</span>
                  <strong>{analytics.totalCommandsInspected}</strong>
                </div>
                <div className="stat-tile">
                  <span>Lines Changed</span>
                  <strong>
                    +{analytics.linesAdded} / -{analytics.linesRemoved}
                  </strong>
                </div>
                <div className="stat-tile">
                  <span>Focus Minutes</span>
                  <strong>{analytics.focusMinutes}m</strong>
                </div>
                <div className="stat-tile">
                  <span>Dictated Words</span>
                  <strong>{analytics.dictatedWords}</strong>
                </div>
              </div>

              {devlogMd && (
                <div className="hub-card">
                  <div className="nova-row-between">
                    <h3>Exported Markdown Devlog</h3>
                    <button
                      className="nova-btn nova-btn-ghost nova-btn-xs"
                      onClick={() => novaApi.copyToClipboard(devlogMd)}
                    >
                      <Copy size={13} /> Copy Markdown
                    </button>
                  </div>
                  <pre className="nova-diff-pre">{devlogMd}</pre>
                </div>
              )}
            </div>
          )}

          {/* 8. MOBILE QR PWA & TELEGRAM BRIDGE */}
          {section === "mobile" && (
            <div className="hub-section">
              <h2>{t(lang, "mobileAndRemote")}</h2>
              <div className="hub-grid-2">
                <div className="hub-card">
                  <div className="nova-row-between">
                    <h3>
                      <QrCode size={16} /> QR Mobile Web / PWA Companion
                    </h3>
                    <label className="nova-checkbox-label">
                      <input
                        type="checkbox"
                        checked={settings.remoteLanEnabled}
                        onChange={(e) =>
                          novaApi.saveSettings({
                            ...settings,
                            remoteLanEnabled: e.target.checked,
                          })
                        }
                      />
                      <span>Enable LAN / Tailscale Access</span>
                    </label>
                  </div>
                  <p className="muted-note">
                    Scan from iPhone or Android on the same Wi-Fi / Tailscale network—approve commands, inspect diffs, and chat with zero APK sideloading.
                  </p>
                  <div
                    className="qr-container"
                    dangerouslySetInnerHTML={{ __html: mobile.qrSvg }}
                  />
                  <code className="mobile-url-code">{mobile.mobileUrl}</code>
                </div>

                <div className="hub-card">
                  <div className="nova-row-between">
                    <h3>Telegram Inline Approval Bot</h3>
                    <label className="nova-checkbox-label">
                      <input
                        type="checkbox"
                        checked={settings.telegramEnabled}
                        onChange={(e) =>
                          novaApi.saveSettings({
                            ...settings,
                            telegramEnabled: e.target.checked,
                          })
                        }
                      />
                      <span>Enable Push Alerts</span>
                    </label>
                  </div>
                  <p className="muted-note">
                    Receive real-time `[✅ Allow]` / `[❌ Deny]` buttons in Telegram when away from your desk.
                  </p>
                  <div className="hub-stack" style={{ marginTop: 10 }}>
                    <div className="nova-row-gap">
                      <input
                        type="password"
                        className="nova-input"
                        placeholder={
                          secrets.telegramToken ? "Bot Token saved" : "Telegram Bot Token..."
                        }
                        value={secretInputs.telegram_token ?? ""}
                        onChange={(e) =>
                          setSecretInputs((p) => ({ ...p, telegram_token: e.target.value }))
                        }
                      />
                      <button
                        className="nova-btn nova-btn-primary nova-btn-xs"
                        onClick={() => handleSaveSecret("telegram_token")}
                      >
                        Save
                      </button>
                    </div>
                    <div className="nova-row-gap">
                      <input
                        className="nova-input"
                        placeholder={
                          secrets.telegramChatId ? "Chat ID saved" : "Your Telegram Chat ID..."
                        }
                        value={secretInputs.telegram_chat_id ?? ""}
                        onChange={(e) =>
                          setSecretInputs((p) => ({ ...p, telegram_chat_id: e.target.value }))
                        }
                      />
                      <button
                        className="nova-btn nova-btn-primary nova-btn-xs"
                        onClick={() => handleSaveSecret("telegram_chat_id")}
                      >
                        Save
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* 9. APPEARANCE, SNAP ZONES & GLOBAL HOTKEYS */}
          {section === "appearance" && (
            <div className="hub-section">
              <h2>{t(lang, "appearanceShortcuts")}</h2>
              <div className="hub-grid-2">
                <div className="hub-card">
                  <h3>Visual Theme, Aura & Avatar Mode</h3>
                  <div className="hub-stack">
                    <div>
                      <label className="muted-note">Surface Material Preset</label>
                      <select
                        className="nova-select"
                        style={{ width: "100%" }}
                        value={settings.theme}
                        onChange={(e) =>
                          novaApi.saveSettings({
                            ...settings,
                            theme: e.target.value as NovaSnapshot["settings"]["theme"],
                          })
                        }
                      >
                        <option value="obsidian">Deep Obsidian Dynamic Island (Default)</option>
                        <option value="acrylic">Windows 11 Frosted Acrylic Glass</option>
                        <option value="tactical">Tactical Monospace HUD</option>
                      </select>
                    </div>

                    <div>
                      <label className="muted-note">Orb / Accent Aura</label>
                      <select
                        className="nova-select"
                        style={{ width: "100%" }}
                        value={settings.aura}
                        onChange={(e) =>
                          novaApi.saveSettings({
                            ...settings,
                            aura: e.target.value as NovaSnapshot["settings"]["aura"],
                          })
                        }
                      >
                        <option value="violet">Singularity Violet (NOVA Signature)</option>
                        <option value="cyan">Obsidian Cyan</option>
                        <option value="amber">Supernova Amber</option>
                        <option value="emerald">Matrix Emerald</option>
                      </select>
                    </div>

                    <div>
                      <label className="muted-note">Startup Launch Intro</label>
                      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                        <select
                          className="nova-select"
                          style={{ flex: 1 }}
                          value={settings.startupIntro ?? "cinematic"}
                          onChange={(e) =>
                            novaApi.saveSettings({
                              ...settings,
                              startupIntro: e.target.value as "cinematic" | "minimal" | "off",
                            })
                          }
                        >
                          <option value="cinematic">Supernova Ignition (Default)</option>
                          <option value="minimal">Minimal Capsule Unfurl</option>
                          <option value="off">Off (Instant Ready)</option>
                        </select>
                        <button
                          type="button"
                          className="nova-btn nova-btn-ghost"
                          style={{ whiteSpace: "nowrap" }}
                          title="Replay the Supernova launch sequence on the Dynamic Island"
                          onClick={() => void novaApi.replayLaunchIntro()}
                        >
                          ↻ Replay Intro
                        </button>
                      </div>
                    </div>

                    <div>
                      <label className="muted-note">Companion Persona</label>
                      <select
                        className="nova-select"
                        style={{ width: "100%" }}
                        value={settings.avatarMode}
                        onChange={(e) =>
                          novaApi.saveSettings({
                            ...settings,
                            avatarMode: e.target.value as "orb" | "hud",
                          })
                        }
                      >
                        <option value="orb">Animated NOVA AI Core / Orb</option>
                        <option value="hud">Pro Minimal HUD Glyph</option>
                      </select>
                    </div>
                  </div>
                </div>

                <div className="hub-card">
                  <h3>Screen Snap Zone & Ergonomics</h3>
                  <div className="hub-stack">
                    <div>
                      <label className="muted-note">Island Snap Zone</label>
                      <select
                        className="nova-select"
                        style={{ width: "100%" }}
                        value={settings.snapZone}
                        onChange={(e) =>
                          novaApi.saveSettings({
                            ...settings,
                            snapZone: e.target.value as NovaSnapshot["settings"]["snapZone"],
                          })
                        }
                      >
                        <option value="top-center">Top-Center Dynamic Island</option>
                        <option value="top-right">Top-Right Corner Pill</option>
                        <option value="top-left">Top-Left Corner Pill</option>
                        <option value="bottom-dock">Bottom Taskbar Floating Dock</option>
                        <option value="free">Free Position</option>
                      </select>
                    </div>

                    <label className="nova-checkbox-label">
                      <input
                        type="checkbox"
                        checked={settings.suppressFullscreen}
                        onChange={(e) =>
                          novaApi.saveSettings({
                            ...settings,
                            suppressFullscreen: e.target.checked,
                          })
                        }
                      />
                      <span>Suppress hover popups during fullscreen games/videos</span>
                    </label>

                    <label className="nova-checkbox-label">
                      <input
                        type="checkbox"
                        checked={settings.detachedOrbVisible}
                        onChange={(e) =>
                          novaApi.saveSettings({
                            ...settings,
                            detachedOrbVisible: e.target.checked,
                          })
                        }
                      />
                      <span>Show Detachable Desktop Floating Orb / Mini HUD</span>
                    </label>
                  </div>
                </div>
              </div>

              <div className="hub-card">
                <h3>Global Hotkeys (with AltGr International Layout Guard)</h3>
                {settings.shortcuts.map((sc, idx) => (
                  <div key={sc.id} className="port-row">
                    <div>
                      <strong>{sc.label}</strong>
                      {sc.altgrConflict && (
                        <span className="badge-warn" style={{ marginLeft: 8 }}>
                          ⚠ {sc.altgrConflict}
                        </span>
                      )}
                    </div>
                    <div className="nova-row-gap">
                      <input
                        className="nova-input nova-input-xs"
                        style={{ width: 165 }}
                        value={sc.accelerator}
                        onChange={(e) => {
                          const updated = settings.shortcuts.map((item, i) =>
                            i === idx ? { ...item, accelerator: e.target.value } : item
                          );
                          novaApi.saveSettings({ ...settings, shortcuts: updated });
                        }}
                      />
                      <input
                        type="checkbox"
                        checked={sc.enabled}
                        onChange={(e) => {
                          const updated = settings.shortcuts.map((item, i) =>
                            i === idx ? { ...item, enabled: e.target.checked } : item
                          );
                          novaApi.saveSettings({ ...settings, shortcuts: updated });
                        }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </main>
      </div>
    </div>
  );
};
