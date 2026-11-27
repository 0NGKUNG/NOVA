use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessAncestor {
    pub pid: u32,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NormalizedHookEnvelope {
    pub agent: String,
    pub event: String,
    pub conversation_id: String,
    pub workspace_path: String,
    #[serde(default)]
    pub transcript_path: Option<String>,
    pub git_branch: Option<String>,
    pub model_name: Option<String>,
    pub last_user_input: Option<String>,
    pub tool_call_id: Option<String>,
    pub tool_name: Option<String>,
    pub tool_args: Value,
    pub command_line: Option<String>,
    pub target_file: Option<String>,
    pub step_idx: Option<u64>,
    pub error: Option<String>,
    pub termination_reason: Option<String>,
    pub subagent_role: Option<String>,
    pub process_chain: Vec<ProcessAncestor>,
    #[serde(default)]
    pub raw_payload: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct HookRelayResponse {
    pub decision: Option<String>,
    pub reason: Option<String>,
    pub permission_overrides: Option<Vec<String>>,
    #[serde(default)]
    pub overwrite: Option<Value>,
    pub inject_system_message: Option<String>,
    #[serde(default)]
    pub inject_user_message: Option<String>,
    #[serde(default)]
    pub inject_error_message: Option<String>,
    #[serde(default)]
    pub termination_behavior: Option<String>,
}

fn default_permission_mode() -> String {
    "follow_agy".to_string()
}

fn default_true() -> bool {
    true
}

fn default_active_account() -> String {
    "main".to_string()
}

fn default_main_account_name() -> String {
    "Main Account".to_string()
}

fn default_second_account_name() -> String {
    "Second Account".to_string()
}

fn default_startup_intro() -> String {
    "cinematic".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShortcutBinding {
    pub id: String,
    pub label: String,
    pub accelerator: String,
    pub enabled: bool,
    pub altgr_conflict: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NovaSettings {
    pub theme: String,        // "obsidian" | "acrylic" | "tactical"
    pub aura: String,         // "cyan" | "amber" | "violet" | "emerald"
    pub avatar_mode: String,  // "orb" | "hud"
    #[serde(default = "default_startup_intro")]
    pub startup_intro: String, // "cinematic" | "minimal" | "off"
    pub snap_zone: String,    // "top-center" | "top-left" | "top-right" | "bottom-dock" | "free"
    pub monitor_index: usize,
    pub follow_active_monitor: bool,
    pub dwell_ms: u64,
    #[serde(default)]
    pub island_collapse_delay_ms: u64,
    pub suppress_fullscreen: bool,
    pub sound_enabled: bool,
    pub custom_sounds_dir: String,
    pub language: String,     // "en" | "th"
    #[serde(default = "default_permission_mode")]
    pub permission_mode: String, // "follow_agy" | "turbo" | "smart_auto" | "request_review"
    #[serde(default = "default_true")]
    pub guard_critical_in_follow: bool,
    pub auto_approve_safe_reads: bool,
    pub agy_approve_in_island: bool,
    pub stt_provider: String, // "groq" | "gemini" | "openai" | "webspeech"
    pub bilingual_cleanup: bool,
    pub default_chat_provider: String, // "cli-antigravity" | "gemini" | "anthropic" | "openai" | "groq" | "openrouter" | "ollama" | "lmstudio"
    pub default_chat_model: String,
    #[serde(default = "default_active_account")]
    pub active_account: String, // "main" | "second"
    #[serde(default = "default_main_account_name")]
    pub main_account_name: String,
    #[serde(default = "default_second_account_name")]
    pub second_account_name: String,
    pub ollama_url: String,
    pub lmstudio_url: String,
    pub remote_lan_enabled: bool,
    pub telegram_enabled: bool,
    pub detached_orb_visible: bool,
    pub autostart: bool,
    pub shortcuts: Vec<ShortcutBinding>,
}

impl Default for NovaSettings {
    fn default() -> Self {
        let sounds_dir = std::env::var("APPDATA")
            .map(|p| format!("{p}\\NOVA\\sounds"))
            .unwrap_or_else(|_| "sounds".to_string());
        Self {
            theme: "obsidian".to_string(),
            aura: "violet".to_string(),
            avatar_mode: "orb".to_string(),
            startup_intro: default_startup_intro(),
            snap_zone: "top-center".to_string(),
            monitor_index: 0,
            follow_active_monitor: false,
            dwell_ms: 100,
            island_collapse_delay_ms: 0,
            suppress_fullscreen: true,
            sound_enabled: true,
            custom_sounds_dir: sounds_dir,
            language: "en".to_string(),
            permission_mode: default_permission_mode(),
            guard_critical_in_follow: true,
            auto_approve_safe_reads: true,
            agy_approve_in_island: true,
            stt_provider: "groq".to_string(),
            bilingual_cleanup: true,
            default_chat_provider: "gemini".to_string(),
            default_chat_model: "gemini-3.8-flash".to_string(),
            active_account: "main".to_string(),
            main_account_name: "Main Account".to_string(),
            second_account_name: "Second Account".to_string(),
            ollama_url: "http://127.0.0.1:11434".to_string(),
            lmstudio_url: "http://127.0.0.1:1234".to_string(),
            remote_lan_enabled: false,
            telegram_enabled: false,
            detached_orb_visible: false,
            autostart: false,
            shortcuts: vec![
                ShortcutBinding {
                    id: "commandPalette".into(),
                    label: "Open Command Bar & Island".into(),
                    accelerator: "Ctrl+Alt+Space".into(),
                    enabled: true,
                    altgr_conflict: None,
                },
                ShortcutBinding {
                    id: "jumpApproval".into(),
                    label: "Focus Waiting Approval".into(),
                    accelerator: "Ctrl+Alt+A".into(),
                    enabled: true,
                    altgr_conflict: None,
                },
                ShortcutBinding {
                    id: "jumpTerminal".into(),
                    label: "Jump to Session Window".into(),
                    accelerator: "Ctrl+Alt+T".into(),
                    enabled: true,
                    altgr_conflict: None,
                },
                ShortcutBinding {
                    id: "visionSnip".into(),
                    label: "Capture Screen for Vision Chat".into(),
                    accelerator: "Ctrl+Alt+X".into(),
                    enabled: true,
                    altgr_conflict: None,
                },
                ShortcutBinding {
                    id: "selectedTextAction".into(),
                    label: "Selected-Text AI Quick Action".into(),
                    accelerator: "Ctrl+Alt+Q".into(),
                    enabled: true,
                    altgr_conflict: None,
                },
                ShortcutBinding {
                    id: "voiceDictate".into(),
                    label: "Push-to-Talk Bilingual Dictation".into(),
                    accelerator: "Ctrl+Alt+V".into(),
                    enabled: true,
                    altgr_conflict: None,
                },
                ShortcutBinding {
                    id: "voiceCommand".into(),
                    label: "Push-to-Talk NOVA Voice Command".into(),
                    accelerator: "Ctrl+Alt+C".into(),
                    enabled: true,
                    altgr_conflict: None,
                },
                ShortcutBinding {
                    id: "toggleOrb".into(),
                    label: "Detach / Dock Desktop Orb".into(),
                    accelerator: "Ctrl+Alt+D".into(),
                    enabled: true,
                    altgr_conflict: None,
                },
                ShortcutBinding {
                    id: "muteToggle".into(),
                    label: "Mute / Unmute NOVA Sounds".into(),
                    accelerator: "Ctrl+Alt+S".into(),
                    enabled: true,
                    altgr_conflict: None,
                },
            ],
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RiskAssessment {
    pub level: String, // "safe" | "low" | "medium" | "high" | "critical"
    pub score: u8,
    pub reasons: Vec<String>,
    pub tags: Vec<String>,
    pub suggested_rule_pattern: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileDiffPreview {
    pub file_path: String,
    pub added_lines: usize,
    pub removed_lines: usize,
    pub unified_diff: String,
    pub timestamp: String,
    #[serde(default)]
    pub start_line: Option<u32>,
    #[serde(default)]
    pub undo_target: Option<String>,
    #[serde(default)]
    pub undo_replacement: Option<String>,
    #[serde(default)]
    pub reverted: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionStep {
    pub id: String,
    #[serde(default)]
    pub call_id: Option<String>,
    pub step_idx: Option<u64>,
    pub event: String,
    pub tool_name: Option<String>,
    pub summary: String,
    #[serde(default)]
    pub detail: Option<String>,
    #[serde(default)]
    pub verb: String,
    #[serde(default)]
    pub file_path: Option<String>,
    #[serde(default)]
    pub line_range: Option<String>,
    #[serde(default)]
    pub start_line: Option<u32>,
    #[serde(default)]
    pub added_lines: Option<usize>,
    #[serde(default)]
    pub removed_lines: Option<usize>,
    #[serde(default)]
    pub unified_diff: Option<String>,
    pub status: String, // "running" | "done" | "error" | "waiting"
    pub timestamp: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanStepItem {
    pub title: String,
    pub status: String, // "pending" | "in_progress" | "done" | "skipped" | "failed"
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FocusGroup {
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub explicit_focus: bool,
    #[serde(default)]
    pub pre_text: Option<String>,
    pub started_at: String,
    #[serde(default)]
    pub ended_at: Option<String>,
    #[serde(default)]
    pub steps: Vec<SessionStep>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubagentNode {
    pub id: String,
    pub role: String,
    pub status: String,
    pub started_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct QuestionItem {
    pub question: String,
    #[serde(default)]
    pub options: Vec<String>,
    #[serde(default)]
    pub is_multi_select: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct QuestionExchange {
    pub id: String,
    pub questions: Vec<QuestionItem>,
    #[serde(default)]
    pub answers: Vec<String>,
    #[serde(default)]
    pub skipped: bool,
    pub timestamp: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SessionArtifact {
    pub path: String,
    pub file_name: String,
    pub summary: String,
    #[serde(default)]
    pub user_facing: bool,
    #[serde(default)]
    pub request_feedback: bool,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingQuestion {
    pub id: String,
    pub conversation_id: String,
    pub agent: String,
    pub workspace_path: String,
    pub workspace_name: String,
    pub git_branch: Option<String>,
    pub questions: Vec<QuestionItem>,
    pub created_at: String,
    pub expires_in_sec: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionTurn {
    pub id: String,
    pub user_prompt: String,
    #[serde(default)]
    pub assistant_output: Option<String>,
    #[serde(default)]
    pub thinking: Option<String>,
    #[serde(default)]
    pub model_name: Option<String>,
    #[serde(default)]
    pub tool_calls_count: usize,
    #[serde(default)]
    pub files_touched_count: usize,
    #[serde(default)]
    pub focus_groups: Vec<FocusGroup>,
    #[serde(default)]
    pub diffs: Vec<FileDiffPreview>,
    #[serde(default)]
    pub question_exchanges: Vec<QuestionExchange>,
    #[serde(default)]
    pub artifacts: Vec<SessionArtifact>,
    #[serde(default)]
    pub started_at: Option<String>,
    #[serde(default)]
    pub completed_at: Option<String>,
    #[serde(default)]
    pub is_active: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSession {
    pub conversation_id: String,
    pub agent: String,
    /// CLI runtime used to create/control this session. `None` means this is
    /// observed app activity rather than a NOVA-managed CLI session.
    #[serde(default)]
    pub runtime_provider: Option<crate::agents::AgentProvider>,
    pub workspace_path: String,
    pub workspace_name: String,
    pub git_branch: Option<String>,
    pub model_name: Option<String>,
    pub last_user_input: Option<String>,
    pub status: String, // "active" | "waiting_approval" | "idle" | "completed" | "error"
    #[serde(default)]
    pub phase: String, // "thinking" | "working" | "waiting_approval" | "done" | "error" | "idle"
    #[serde(default)]
    pub current_focus: Option<String>,
    #[serde(default)]
    pub mid_process_note: Option<String>,
    #[serde(default)]
    pub latest_thinking: Option<String>,
    #[serde(default)]
    pub latest_output: Option<String>,
    #[serde(default)]
    pub plan_steps: Vec<PlanStepItem>,
    #[serde(default)]
    pub focus_groups: Vec<FocusGroup>,
    #[serde(default)]
    pub question_exchanges: Vec<QuestionExchange>,
    #[serde(default)]
    pub artifacts: Vec<SessionArtifact>,
    #[serde(default)]
    pub turns: Vec<SessionTurn>,
    #[serde(default)]
    pub transcript_path: Option<String>,
    #[serde(default)]
    pub queued_messages: Vec<String>,
    #[serde(default)]
    pub stop_requested: bool,
    #[serde(default)]
    pub bg_running: bool,
    #[serde(default)]
    pub cli_conversation_id: Option<String>,
    #[serde(default)]
    pub last_error: Option<String>,
    #[serde(default)]
    pub detected_ide_permission: Option<String>,
    #[serde(default)]
    pub permission_override: Option<String>,
    pub active_tool: Option<String>,
    pub steps: Vec<SessionStep>,
    pub diffs: Vec<FileDiffPreview>,
    pub subagents: Vec<SubagentNode>,
    pub process_chain: Vec<ProcessAncestor>,
    pub started_at: String,
    pub updated_at: String,
    pub commands_count: usize,
    pub files_touched_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingApproval {
    pub id: String,
    pub conversation_id: String,
    pub agent: String,
    pub workspace_path: String,
    pub workspace_name: String,
    pub git_branch: Option<String>,
    pub tool_name: String,
    pub command_line: Option<String>,
    pub target_file: Option<String>,
    pub tool_args: Value,
    pub risk: RiskAssessment,
    pub diff_preview: Option<FileDiffPreview>,
    pub created_at: String,
    pub expires_in_sec: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalRule {
    pub id: String,
    pub action: String, // "allow" | "deny"
    pub scope: String,  // "session" | "workspace" | "global"
    pub scope_target: Option<String>,
    pub tool_matcher: String, // "run_command" | "edit_file" | "*"
    pub pattern: String,      // prefix or substring match
    pub label: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatMessage {
    pub id: String,
    pub role: String, // "user" | "assistant" | "system"
    pub content: String,
    pub thinking: Option<String>,
    pub provider: Option<String>,
    pub model: Option<String>,
    pub image_data_url: Option<String>,
    pub attached_file: Option<String>,
    pub timestamp: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatPersona {
    pub id: String,
    pub name: String,
    pub icon: String,
    pub system_prompt: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatThread {
    pub id: String,
    pub title: String,
    pub persona_id: String,
    #[serde(default)]
    pub workspace_path: Option<String>,
    pub messages: Vec<ChatMessage>,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipboardEntry {
    pub id: String,
    pub kind: String, // "text" | "code" | "path" | "url"
    pub content: String,
    pub preview: String,
    pub pinned: bool,
    pub timestamp: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TechTerm {
    pub spoken: String,
    pub canonical: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceSnippet {
    pub trigger: String,
    pub expansion: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionItem {
    pub id: String,
    pub text: String,
    pub done: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceNote {
    pub id: String,
    pub title: String,
    pub mode: String, // "meeting" | "memo" | "dictation"
    pub language: String,
    pub raw_transcript: String,
    pub summary: String,
    pub action_items: Vec<ActionItem>,
    pub duration_sec: u64,
    pub word_count: usize,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PortProcessInfo {
    pub port: u16,
    pub proto: String,
    pub local_address: String,
    pub pid: u32,
    pub process_name: String,
    pub framework_hint: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GpuTelemetry {
    pub name: String,
    pub load_percent: f32,
    pub vram_used_mb: u64,
    pub vram_total_mb: u64,
    pub temp_c: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TopProcessInfo {
    pub pid: u32,
    pub name: String,
    pub cpu_percent: f32,
    pub memory_mb: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HardwareTelemetry {
    pub cpu_percent: f32,
    pub cpu_brand: String,
    pub core_count: usize,
    pub ram_used_gb: f32,
    pub ram_total_gb: f32,
    pub ram_percent: f32,
    pub gpu: Option<GpuTelemetry>,
    pub top_processes: Vec<TopProcessInfo>,
    pub fullscreen_active: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaStatus {
    pub active: bool,
    pub playing: bool,
    pub title: String,
    pub artist: String,
    pub source_app: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitHubPullItem {
    pub number: u64,
    pub title: String,
    pub repo: String,
    pub url: String,
    pub state: String,
    pub draft: bool,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitHubWorkflowItem {
    pub id: u64,
    pub name: String,
    pub repo: String,
    pub status: String,
    pub conclusion: Option<String>,
    pub branch: String,
    pub url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitHubOverview {
    pub connected: bool,
    pub username: Option<String>,
    pub avatar_url: Option<String>,
    pub my_prs: Vec<GitHubPullItem>,
    pub review_requests: Vec<GitHubPullItem>,
    pub recent_runs: Vec<GitHubWorkflowItem>,
    pub fetched_at: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TodoItem {
    pub id: String,
    pub text: String,
    pub completed: bool,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FocusState {
    pub running: bool,
    pub mode: String, // "focus" | "short_break" | "long_break"
    pub remaining_sec: u64,
    pub total_sec: u64,
    pub current_goal: String,
    pub completed_blocks_today: usize,
    pub total_focus_minutes: u64,
    pub todos: Vec<TodoItem>,
    pub scratchpad_markdown: String,
}

impl Default for FocusState {
    fn default() -> Self {
        Self {
            running: false,
            mode: "focus".to_string(),
            remaining_sec: 25 * 60,
            total_sec: 25 * 60,
            current_goal: "Deep Focus Sprint".to_string(),
            completed_blocks_today: 0,
            total_focus_minutes: 0,
            todos: vec![
                TodoItem {
                    id: "todo-1".into(),
                    text: "Connect Antigravity hooks in NOVA Settings".into(),
                    completed: false,
                    created_at: chrono::Utc::now().to_rfc3339(),
                },
            ],
            scratchpad_markdown: "# Quick Scratchpad\n- Drop ideas, commands, or bilingual notes here...\n".to_string(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AnalyticsCounters {
    pub total_sessions: usize,
    pub total_commands_inspected: usize,
    pub approvals_allowed: usize,
    pub approvals_denied: usize,
    pub approvals_auto_passed: usize,
    pub files_edited: usize,
    pub lines_added: usize,
    pub lines_removed: usize,
    pub dictations_count: usize,
    pub dictated_words: usize,
    pub focus_minutes: u64,
    pub top_workspaces: std::collections::HashMap<String, usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgyHookStatus {
    pub hooks_json_path: String,
    pub hook_binary_path: String,
    pub hook_binary_exists: bool,
    pub nova_installed: bool,
    pub nova_enabled: bool,
    pub coucou_detected: bool,
    pub coucou_enabled: bool,
    pub diff_preview: String,
    pub proposed_json: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MobilePairingInfo {
    pub enabled: bool,
    pub lan_ip: String,
    pub port: u16,
    pub mobile_url: String,
    pub pairing_token: String,
    pub qr_svg: String,
    pub telegram_configured: bool,
    pub telegram_enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretPresenceMap {
    pub gemini: bool,
    pub gemini_second: bool,
    pub anthropic: bool,
    pub openai: bool,
    pub groq: bool,
    pub openrouter: bool,
    pub github: bool,
    pub telegram_token: bool,
    pub telegram_chat_id: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AccountQuotaInfo {
    pub account_id: String, // "main" | "second"
    pub account_name: String,
    pub provider: String,
    pub model: String,
    pub tier: String,
    pub rpm_limit: u32,
    pub rpm_used: u32,
    pub rpd_limit: u32,
    pub rpd_used: u32,
    pub tpm_limit: u64,
    pub tpm_used: u64,
    pub total_tokens_today: u64,
    pub percentage_used: f32,
    pub status: String, // "healthy" | "warning" | "exceeded" | "unconfigured"
    pub reset_in_seconds: u64,
    pub last_error: Option<String>,
    pub last_updated: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct RealtimeQuotaState {
    pub main: AccountQuotaInfo,
    pub second: AccountQuotaInfo,
    pub active_account: String,
    pub active_model: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceEntry {
    pub name: String,
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NovaSnapshot {
    pub version: String,
    pub settings: NovaSettings,
    pub sessions: Vec<AgentSession>,
    pub pending_approvals: Vec<PendingApproval>,
    #[serde(default)]
    pub pending_questions: Vec<PendingQuestion>,
    pub approval_rules: Vec<ApprovalRule>,
    pub threads: Vec<ChatThread>,
    pub personas: Vec<ChatPersona>,
    pub clipboard_history: Vec<ClipboardEntry>,
    pub tech_dictionary: Vec<TechTerm>,
    pub voice_snippets: Vec<VoiceSnippet>,
    pub voice_notes: Vec<VoiceNote>,
    pub focus: FocusState,
    pub analytics: AnalyticsCounters,
    pub agy_hooks: AgyHookStatus,
    pub secrets: SecretPresenceMap,
    #[serde(default)]
    pub quota: RealtimeQuotaState,
    pub mobile: MobilePairingInfo,
    #[serde(default)]
    pub recent_workspaces: Vec<WorkspaceEntry>,
    #[serde(default)]
    pub agy_cli_available: bool,
    #[serde(default)]
    pub detected_ide_permission: Option<String>,
}
