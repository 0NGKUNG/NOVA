use crate::agy_hooks::{inspect_antigravity_hooks, nova_data_dir};
use crate::ai_services::{build_mobile_pairing_info, secret_presence_map, send_telegram_approval_alert};
use crate::models::{
    AgentSession, AnalyticsCounters, ApprovalRule, ChatMessage, ChatPersona, ChatThread,
    ClipboardEntry, FileDiffPreview, FocusGroup, FocusState, HookRelayResponse,
    NormalizedHookEnvelope, NovaSettings, NovaSnapshot, PendingApproval, PlanStepItem, SessionStep,
    SubagentNode, TechTerm, VoiceNote, VoiceSnippet,
};
use crate::risk::{assess_tool_risk, build_file_diff_preview};
use crate::system_tools::{
    annotate_altgr_conflicts, detect_antigravity_permission_mode, discover_recent_workspaces,
    kill_owned_child_tree, local_lan_ipv4, read_clipboard_text, resolve_agy_cli_path,
    save_snip_png_to_disk, spawn_headless_agy_turn,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use sysinfo::System;
use tokio::sync::{broadcast, oneshot};

pub const CORE_PORT: u16 = 47920;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct PersistedStore {
    settings: NovaSettings,
    approval_rules: Vec<ApprovalRule>,
    threads: Vec<ChatThread>,
    personas: Vec<ChatPersona>,
    tech_dictionary: Vec<TechTerm>,
    voice_snippets: Vec<VoiceSnippet>,
    voice_notes: Vec<VoiceNote>,
    focus: FocusState,
    analytics: AnalyticsCounters,
}

pub struct InnerState {
    pub settings: NovaSettings,
    pub sessions: Vec<AgentSession>,
    pub pending_approvals: Vec<PendingApproval>,
    pub approval_waiters: HashMap<String, oneshot::Sender<HookRelayResponse>>,
    pub pending_tool_diffs: HashMap<String, FileDiffPreview>,
    pub bg_pids: HashMap<String, u32>,
    pub approval_rules: Vec<ApprovalRule>,
    pub threads: Vec<ChatThread>,
    pub personas: Vec<ChatPersona>,
    pub clipboard_history: Vec<ClipboardEntry>,
    pub tech_dictionary: Vec<TechTerm>,
    pub voice_snippets: Vec<VoiceSnippet>,
    pub voice_notes: Vec<VoiceNote>,
    pub focus: FocusState,
    pub analytics: AnalyticsCounters,
    pub ipc_token: String,
    pub pairing_token: String,
    pub lan_ip: String,
}

#[derive(Clone)]
pub struct AppCore {
    pub inner: Arc<Mutex<InnerState>>,
    pub sys: Arc<Mutex<System>>,
    pub events_tx: broadcast::Sender<Value>,
}

fn default_personas() -> Vec<ChatPersona> {
    vec![
        ChatPersona {
            id: "architect".into(),
            name: "NOVA Staff Architect (EN/TH)".into(),
            icon: "sparkles".into(),
            system_prompt: "You are NOVA, a sharp, concise Staff Software Engineer & desktop AI copilot. Answer in the user's language (seamless English or Thai ภาษาไทย with exact English technical terms). Prefer actionable code and direct root-cause clarity.".into(),
        },
        ChatPersona {
            id: "debugger".into(),
            name: "Rapid Debugger".into(),
            icon: "bug".into(),
            system_prompt: "You are NOVA Rapid Debugger. Pinpoint the exact root cause, failure line, and minimal safe fix with zero fluff.".into(),
        },
        ChatPersona {
            id: "translator".into(),
            name: "Bilingual Tech Polisher (TH ⇄ EN)".into(),
            icon: "languages".into(),
            system_prompt: "Polish or translate developer messages between Thai (ภาษาไทย) and English while keeping technical identifiers, APIs, and code idioms natural and accurate.".into(),
        },
    ]
}

fn default_tech_dictionary() -> Vec<TechTerm> {
    vec![
        TechTerm { spoken: "แอนติกราวิตี้".into(), canonical: "Antigravity".into() },
        TechTerm { spoken: "เทาริ".into(), canonical: "Tauri v2".into() },
        TechTerm { spoken: "ไทป์สคริปต์".into(), canonical: "TypeScript".into() },
        TechTerm { spoken: "รีแอค".into(), canonical: "React".into() },
        TechTerm { spoken: "พาวเวอร์เชลล์".into(), canonical: "PowerShell".into() },
        TechTerm { spoken: "กิตฮับ".into(), canonical: "GitHub".into() },
        TechTerm { spoken: "เวอเซล".into(), canonical: "Vercel".into() },
        TechTerm { spoken: "ซูพาเบส".into(), canonical: "Supabase".into() },
    ]
}

fn default_voice_snippets() -> Vec<VoiceSnippet> {
    vec![
        VoiceSnippet {
            trigger: "nova build check".into(),
            expansion: "cargo check --workspace && npm run build".into(),
        },
        VoiceSnippet {
            trigger: "เช็คสเตตัส".into(),
            expansion: "git status -sb && git log -n 3 --oneline".into(),
        },
    ]
}

fn ensure_token_file(filename: &str) -> String {
    let path = nova_data_dir().join(filename);
    if let Ok(existing) = fs::read_to_string(&path) {
        let t = existing.trim();
        if t.len() >= 32 && t.chars().all(|c| c.is_ascii_hexdigit()) {
            return t.to_string();
        }
    }
    let token = format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    );
    let _ = fs::write(&path, &token);
    token
}

fn truncate_chars(s: &str, max_chars: usize) -> String {
    let trimmed = s.trim();
    if trimmed.chars().count() <= max_chars {
        trimmed.to_string()
    } else {
        let mut out: String = trimmed.chars().take(max_chars).collect();
        out.push('…');
        out
    }
}

/// Strips `<USER_REQUEST>`, `<ADDITIONAL_METADATA>`, and `<SYSTEM_MESSAGE>` wrappers from prompts.
fn clean_user_prompt(raw: &str) -> Option<String> {
    let has_image = raw.contains("uploaded") && raw.contains("image(s):");
    let extracted = if let (Some(start), Some(end)) =
        (raw.find("<USER_REQUEST>"), raw.find("</USER_REQUEST>"))
    {
        let inner_start = start + "<USER_REQUEST>".len();
        if end >= inner_start {
            &raw[inner_start..end]
        } else {
            raw
        }
    } else {
        let cut = raw
            .find("<ADDITIONAL_METADATA>")
            .or_else(|| raw.find("<SYSTEM_MESSAGE>"))
            .unwrap_or(raw.len());
        &raw[..cut]
    };

    let collapsed = extracted
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .collect::<Vec<_>>()
        .join(" ");

    if collapsed.is_empty() {
        if has_image {
            return Some("📎 Screenshot / media attached".to_string());
        }
        return None;
    }
    Some(truncate_chars(&collapsed, 240))
}

fn humanize_model_name(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed.eq_ignore_ascii_case("auto") {
        return None;
    }
    let lower = trimmed.to_ascii_lowercase();
    if lower == "gemini-4-carbon-high" {
        return Some("Gemini 4 Carbon (High)".to_string());
    }
    if lower == "gemini-4-carbon" {
        return Some("Gemini 4 Carbon".to_string());
    }
    Some(trimmed.to_string())
}

/// Unwraps protojson double-encoded string values found in `transcript.jsonl` tool_calls args.
fn unwrap_protojson_arg(val: &Value) -> Value {
    if let Value::String(s) = val {
        let trimmed = s.trim();
        if (trimmed.starts_with('"') && trimmed.ends_with('"'))
            || (trimmed.starts_with('[') && trimmed.ends_with(']'))
            || (trimmed.starts_with('{') && trimmed.ends_with('}'))
        {
            if let Ok(parsed) = serde_json::from_str::<Value>(trimmed) {
                return parsed;
            }
        }
    }
    val.clone()
}

fn arg_string(args: &Value, keys: &[&str]) -> Option<String> {
    for k in keys {
        if let Some(v) = args.get(*k) {
            let unwrapped = unwrap_protojson_arg(v);
            if let Some(s) = unwrapped.as_str() {
                let t = s.trim();
                if !t.is_empty() {
                    return Some(t.to_string());
                }
            } else if let Some(n) = unwrapped.as_i64() {
                return Some(n.to_string());
            } else if let Some(n) = unwrapped.as_u64() {
                return Some(n.to_string());
            }
        }
    }
    None
}

fn extract_focus_phrase(args: &Value) -> Option<String> {
    arg_string(args, &["focus"]).map(|s| truncate_chars(&s, 140))
}

fn extract_plan_steps(args: &Value) -> Option<Vec<PlanStepItem>> {
    let raw_steps = args.get("steps")?;
    let unwrapped = unwrap_protojson_arg(raw_steps);
    let arr = unwrapped.as_array()?;
    let mut out = Vec::with_capacity(arr.len());
    for item in arr.iter().take(14) {
        let title = item
            .get("title")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .unwrap_or_default();
        if title.is_empty() {
            continue;
        }
        let status = item
            .get("status")
            .and_then(|v| v.as_str())
            .unwrap_or("pending")
            .to_string();
        out.push(PlanStepItem {
            title: truncate_chars(title, 90),
            status,
        });
    }
    Some(out)
}

#[derive(Debug, Clone)]
struct FormattedStepMeta {
    verb: String,
    summary: String,
    detail: Option<String>,
    file_path: Option<String>,
    line_range: Option<String>,
    start_line: Option<u32>,
}

fn detect_git_branch_for_dir(workspace: &str) -> Option<String> {
    if workspace.trim().is_empty() {
        return None;
    }
    let mut cur = Some(Path::new(workspace));
    while let Some(dir) = cur {
        let head = dir.join(".git").join("HEAD");
        if let Ok(contents) = fs::read_to_string(&head) {
            let trimmed = contents.trim();
            if let Some(rest) = trimmed.strip_prefix("ref: refs/heads/") {
                return Some(rest.to_string());
            }
            if trimmed.len() >= 7 {
                return Some(trimmed[..7].to_string());
            }
        }
        cur = dir.parent();
    }
    None
}

/// Formats structured IDE action rows (`Analyzed`, `Edited`, `Created`, `Ran`, `Searched`)
/// and filters out meta-tools (`update_focus`, `update_steps`).
fn format_tool_step(
    tool_name: &str,
    args: &Value,
    cmd_line: Option<&str>,
    target_file: Option<&str>,
) -> Option<FormattedStepMeta> {
    if tool_name.is_empty() {
        return None;
    }
    if matches!(tool_name, "update_focus" | "update_steps" | "TodoWrite") {
        return None;
    }

    let file_basename = |fp: &str| -> String {
        Path::new(fp)
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| fp.to_string())
    };

    match tool_name {
        "run_command" | "Bash" => {
            let summary_hint = arg_string(args, &["toolSummary", "description"]);
            let raw_cmd = cmd_line
                .map(|s| s.to_string())
                .or_else(|| arg_string(args, &["CommandLine", "command", "cmd"]));
            let first_line_cmd = raw_cmd
                .as_deref()
                .and_then(|c| c.lines().map(str::trim).find(|l| !l.is_empty()))
                .map(|l| truncate_chars(l, 96));

            let (summary, detail) = match (summary_hint, first_line_cmd) {
                (Some(sum), Some(cmd)) => (sum, Some(cmd)),
                (Some(sum), None) => (sum, None),
                (None, Some(cmd)) => (cmd, None),
                (None, None) => ("terminal command".to_string(), None),
            };
            Some(FormattedStepMeta {
                verb: "Ran".to_string(),
                summary,
                detail,
                file_path: None,
                line_range: None,
                start_line: None,
            })
        }
        "read_file" | "view_file" | "Read" => {
            let fp = target_file
                .map(|s| s.to_string())
                .or_else(|| arg_string(args, &["Path", "file_path", "AbsolutePath"]))
                .unwrap_or_default();
            let base = file_basename(&fp);
            let s_str = arg_string(args, &["StartLine", "offset"]);
            let e_str = arg_string(args, &["EndLine", "limit"]);
            let start_line = s_str.as_deref().and_then(|s| s.parse::<u32>().ok());
            let line_range = match (s_str, e_str) {
                (Some(s), Some(e)) => Some(format!("#L{s}-{e}")),
                (Some(s), None) => Some(format!("#L{s}")),
                _ => None,
            };
            Some(FormattedStepMeta {
                verb: "Analyzed".to_string(),
                summary: base,
                detail: None,
                file_path: if fp.is_empty() { None } else { Some(fp) },
                line_range,
                start_line,
            })
        }
        "edit_file" | "replace_file_content" | "multi_replace_file_content" | "Edit" | "MultiEdit" => {
            let fp = target_file
                .map(|s| s.to_string())
                .or_else(|| arg_string(args, &["Path", "TargetFile", "file_path"]))
                .unwrap_or_default();
            Some(FormattedStepMeta {
                verb: "Edited".to_string(),
                summary: file_basename(&fp),
                detail: None,
                file_path: if fp.is_empty() { None } else { Some(fp) },
                line_range: None,
                start_line: None,
            })
        }
        "write_file" | "write_to_file" | "Write" => {
            let fp = target_file
                .map(|s| s.to_string())
                .or_else(|| arg_string(args, &["Path", "TargetFile", "file_path"]))
                .unwrap_or_default();
            Some(FormattedStepMeta {
                verb: "Created".to_string(),
                summary: file_basename(&fp),
                detail: None,
                file_path: if fp.is_empty() { None } else { Some(fp) },
                line_range: None,
                start_line: None,
            })
        }
        "search_web" | "WebSearch" => {
            let q = arg_string(args, &["query"]).unwrap_or_else(|| "web".into());
            Some(FormattedStepMeta {
                verb: "Searched".to_string(),
                summary: format!("web: {}", truncate_chars(&q, 72)),
                detail: None,
                file_path: None,
                line_range: None,
                start_line: None,
            })
        }
        "grep_search" | "find_by_name" | "Grep" | "Glob" | "list_dir" => {
            let q = arg_string(args, &["Query", "Pattern", "pattern", "DirectoryPath"])
                .unwrap_or_else(|| "workspace".into());
            Some(FormattedStepMeta {
                verb: "Searched".to_string(),
                summary: truncate_chars(&q, 72),
                detail: None,
                file_path: None,
                line_range: None,
                start_line: None,
            })
        }
        "invoke_subagent" | "Task" | "swarm" => {
            let role = arg_string(args, &["Role", "description", "TypeName", "name"])
                .unwrap_or_else(|| "Worker".into());
            Some(FormattedStepMeta {
                verb: "Subagent".to_string(),
                summary: truncate_chars(&role, 64),
                detail: None,
                file_path: None,
                line_range: None,
                start_line: None,
            })
        }
        "manage_task" => {
            let act = arg_string(args, &["Action"]).unwrap_or_else(|| "check".into());
            Some(FormattedStepMeta {
                verb: "Task".to_string(),
                summary: format!("background: {act}"),
                detail: None,
                file_path: None,
                line_range: None,
                start_line: None,
            })
        }
        "ask_question" | "AskUserQuestion" => Some(FormattedStepMeta {
            verb: "Asked".to_string(),
            summary: "Waiting for user answer".into(),
            detail: None,
            file_path: None,
            line_range: None,
            start_line: None,
        }),
        other => Some(FormattedStepMeta {
            verb: "Called".to_string(),
            summary: other.replace('_', " "),
            detail: None,
            file_path: None,
            line_range: None,
            start_line: None,
        }),
    }
}

fn discover_transcript_path(
    conversation_id: &str,
    explicit: Option<&str>,
    raw_payload: &Value,
) -> Option<String> {
    if let Some(p) = explicit.map(str::trim).filter(|s| !s.is_empty()) {
        if Path::new(p).exists() {
            return Some(p.to_string());
        }
    }
    for key in ["transcriptPath", "transcript_path"] {
        if let Some(p) = raw_payload.get(key).and_then(|v| v.as_str()).map(str::trim) {
            if !p.is_empty() && Path::new(p).exists() {
                return Some(p.to_string());
            }
        }
    }
    if !conversation_id.is_empty()
        && conversation_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-')
    {
        if let Some(home) = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")) {
            let candidate = PathBuf::from(home)
                .join(".gemini")
                .join("antigravity")
                .join("brain")
                .join(conversation_id)
                .join(".system_generated")
                .join("logs")
                .join("transcript.jsonl");
            if candidate.is_file() {
                return Some(candidate.to_string_lossy().to_string());
            }
        }
    }
    None
}

#[derive(Default, Debug)]
struct TranscriptInsights {
    has_explicit_turn: bool,
    user_prompt: Option<String>,
    model_name: Option<String>,
    latest_thinking: Option<String>,
    latest_output: Option<String>,
    mid_process_note: Option<String>,
    current_focus: Option<String>,
    plan_steps: Option<Vec<PlanStepItem>>,
    focus_groups: Vec<FocusGroup>,
    diffs: Vec<FileDiffPreview>,
    detected_ide_permission: Option<String>,
}

fn auto_summarize_group_steps(steps: &[SessionStep]) -> String {
    let mut has_read = false;
    let mut has_edit = false;
    let mut has_cmd = false;
    let mut has_sub = false;
    for st in steps {
        match st.verb.as_str() {
            "Analyzed" | "Searched" => has_read = true,
            "Edited" | "Created" => has_edit = true,
            "Ran" => has_cmd = true,
            "Subagent" => has_sub = true,
            _ => {}
        }
    }
    let mut parts = Vec::new();
    if has_read {
        parts.push("explored files");
    }
    if has_edit {
        parts.push("edited files");
    }
    if has_cmd {
        parts.push("ran commands");
    }
    if has_sub {
        parts.push("ran subagents");
    }
    if parts.is_empty() {
        return steps
            .last()
            .map(|s| format!("{} {}", s.verb, s.summary))
            .unwrap_or_else(|| "Working…".to_string());
    }
    let mut joined = parts.join(", ");
    if let Some(first) = joined.get_mut(0..1) {
        first.make_ascii_uppercase();
    }
    joined
}

fn parse_ide_permission_hint(raw: &str) -> Option<String> {
    let (_, after) = raw.split_once("<USER_SETTINGS_CHANGE>")?;
    let body = after
        .split_once("</USER_SETTINGS_CHANGE>")
        .map(|(b, _)| b)
        .unwrap_or(after)
        .to_ascii_lowercase();
    if body.contains("turbo") {
        Some("Turbo".to_string())
    } else if body.contains("request review") || body.contains("review") {
        Some("Request Review".to_string())
    } else if body.contains("auto") {
        Some("Auto".to_string())
    } else if body.contains("default") {
        Some("Default".to_string())
    } else {
        None
    }
}

fn extract_latest_thinking_paragraph(raw: &str) -> Option<String> {
    let paragraphs: Vec<&str> = raw
        .split("\n\n")
        .map(str::trim)
        .filter(|p| !p.is_empty())
        .collect();
    let chosen = paragraphs.last().copied().unwrap_or_else(|| raw.trim());
    let clean = chosen
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    if clean.is_empty() {
        None
    } else {
        Some(truncate_chars(&clean, 380))
    }
}

fn clean_assistant_output(raw: &str) -> Option<String> {
    let without_sys = raw
        .find("\n\nThe following is a <SYSTEM_MESSAGE>")
        .map(|i| &raw[..i])
        .unwrap_or(raw);
    let without_trunc = without_sys
        .find("\n<truncated ")
        .map(|i| &without_sys[..i])
        .unwrap_or(without_sys)
        .trim();
    if without_trunc.is_empty() {
        None
    } else {
        Some(truncate_chars(without_trunc, 8_500))
    }
}

fn read_untruncated_step_content(compact_path: &Path, step_index: u64) -> Option<String> {
    let full_path = compact_path.with_file_name("transcript_full.jsonl");
    let mut file = fs::File::open(full_path).ok()?;
    let len = file.metadata().ok()?.len();
    let start = len.saturating_sub(524_288);
    file.seek(SeekFrom::Start(start)).ok()?;
    let mut buf = Vec::with_capacity((len - start) as usize);
    file.read_to_end(&mut buf).ok()?;
    let text = String::from_utf8_lossy(&buf);
    let needle = format!("\"step_index\":{step_index}");
    for line in text.lines().rev() {
        if line.contains(&needle) {
            if let Ok(obj) = serde_json::from_str::<Value>(line.trim()) {
                if obj.get("step_index").and_then(|v| v.as_u64()) == Some(step_index) {
                    return obj
                        .get("content")
                        .and_then(|v| v.as_str())
                        .and_then(clean_assistant_output);
                }
            }
        }
    }
    None
}

/// Fast tail-reader (~0.3 ms) that extracts live Thinking, Focus, Checklist Steps, and Output
/// from the last 192 KB of Antigravity's `transcript.jsonl`.
fn read_transcript_insights(path_str: &str) -> Option<TranscriptInsights> {
    let path = Path::new(path_str);
    if !path.is_file() || path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
        return None;
    }

    let mut file = fs::File::open(path).ok()?;
    let len = file.metadata().ok()?.len();
    if len == 0 {
        return None;
    }

    const TAIL_BYTES: u64 = 196_608;
    let start = len.saturating_sub(TAIL_BYTES);
    file.seek(SeekFrom::Start(start)).ok()?;

    let mut buf = Vec::with_capacity((len - start) as usize);
    file.read_to_end(&mut buf).ok()?;
    let text = String::from_utf8_lossy(&buf);

    let mut lines = text.lines();
    if start > 0 {
        // Discard partial first line when seeking mid-file
        let _ = lines.next();
    }

    let mut out = TranscriptInsights::default();

    for line in lines {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Ok(obj) = serde_json::from_str::<Value>(trimmed) else {
            continue;
        };
        let step_type = obj.get("type").and_then(|v| v.as_str()).unwrap_or_default();
        let source = obj
            .get("source")
            .and_then(|v| v.as_str())
            .unwrap_or_default();

        if step_type == "USER_INPUT" {
            if let Some(c) = obj.get("content").and_then(|v| v.as_str()) {
                if let Some(perm) = parse_ide_permission_hint(c) {
                    out.detected_ide_permission = Some(perm);
                }
                if source == "USER_EXPLICIT" {
                    out.has_explicit_turn = true;
                    if let Some(cleaned) = clean_user_prompt(c) {
                        out.user_prompt = Some(cleaned);
                    }
                    // Strictly scope steps, focus groups, diffs, notes & output to the CURRENT user turn only!
                    out.plan_steps = None;
                    out.current_focus = None;
                    out.focus_groups.clear();
                    out.diffs.clear();
                    out.latest_thinking = None;
                    out.latest_output = None;
                    out.mid_process_note = None;
                }
            }
            continue;
        }

        if step_type == "PLANNER_RESPONSE" {
            let step_ts = obj
                .get("created_at")
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty())
                .map(|s| s.to_string())
                .unwrap_or_else(|| chrono::Utc::now().to_rfc3339());

            if let Some(m) = obj.get("model").and_then(|v| v.as_str()) {
                if let Some(hm) = humanize_model_name(m) {
                    out.model_name = Some(hm);
                }
            }
            if let Some(th) = obj.get("thinking").and_then(|v| v.as_str()) {
                if let Some(clean_th) = extract_latest_thinking_paragraph(th) {
                    out.latest_thinking = Some(clean_th);
                }
            }
            let tool_calls = obj.get("tool_calls").and_then(|v| v.as_array());
            let has_tool_calls = tool_calls.is_some_and(|a| !a.is_empty());

            let content_truncated = obj
                .get("truncated_fields")
                .and_then(|v| v.as_array())
                .is_some_and(|arr| arr.iter().any(|x| x.as_str() == Some("content")));

            if let Some(content) = obj.get("content").and_then(|v| v.as_str()) {
                let resolved_out = if !has_tool_calls && content_truncated {
                    obj.get("step_index")
                        .and_then(|v| v.as_u64())
                        .and_then(|idx| read_untruncated_step_content(path, idx))
                        .or_else(|| clean_assistant_output(content))
                } else {
                    clean_assistant_output(content)
                };

                if let Some(clean_out) = resolved_out {
                    if has_tool_calls {
                        // Mid-process status note emitted alongside tool calls (NOT final output)
                        let compact_note = clean_out
                            .lines()
                            .map(str::trim)
                            .filter(|l| !l.is_empty())
                            .collect::<Vec<_>>()
                            .join(" ");
                        out.mid_process_note = Some(truncate_chars(&compact_note, 230));
                    } else {
                        out.latest_output = Some(clean_out);
                        out.mid_process_note = None;
                    }
                } else if !has_tool_calls {
                    out.mid_process_note = None;
                }
            } else if !has_tool_calls {
                out.mid_process_note = None;
            }

            if !has_tool_calls {
                if let Some(last_grp) = out.focus_groups.last_mut() {
                    if last_grp.ended_at.is_none() {
                        last_grp.ended_at = Some(step_ts.clone());
                    }
                }
            }

            if let Some(tcs) = tool_calls {
                for tc in tcs {
                    let name = tc.get("name").and_then(|v| v.as_str()).unwrap_or_default();
                    let args = tc.get("args").unwrap_or(&Value::Null);
                    let call_id = tc.get("id").and_then(|v| v.as_str()).map(|s| s.to_string());

                    if name == "update_focus" {
                        if let Some(f) = extract_focus_phrase(args) {
                            out.current_focus = Some(f.clone());
                            if let Some(prev) = out.focus_groups.last_mut() {
                                if prev.steps.is_empty() {
                                    prev.title = f;
                                    prev.explicit_focus = true;
                                    prev.started_at = step_ts.clone();
                                    continue;
                                } else if prev.ended_at.is_none() {
                                    prev.ended_at = Some(step_ts.clone());
                                }
                            }
                            out.focus_groups.push(FocusGroup {
                                id: format!("fg-{}", out.focus_groups.len() + 1),
                                title: f,
                                explicit_focus: true,
                                started_at: step_ts.clone(),
                                ended_at: None,
                                steps: Vec::new(),
                            });
                        }
                    } else if name == "update_steps" {
                        if let Some(st) = extract_plan_steps(args) {
                            out.plan_steps = Some(st);
                        }
                    } else if let Some(meta) = format_tool_step(name, args, None, None) {
                        let tr_diff = build_file_diff_preview(name, meta.file_path.as_deref(), args);
                        let step_added = tr_diff.as_ref().map(|d| d.added_lines);
                        let step_removed = tr_diff.as_ref().map(|d| d.removed_lines);
                        let step_start_line = tr_diff
                            .as_ref()
                            .and_then(|d| d.start_line)
                            .or(meta.start_line);
                        if let Some(mut dp) = tr_diff {
                            dp.timestamp = step_ts.clone();
                            out.diffs.push(dp);
                        }

                        let need_new = out
                            .focus_groups
                            .last()
                            .is_none_or(|g| g.ended_at.is_some());
                        if need_new {
                            out.focus_groups.push(FocusGroup {
                                id: format!("fg-{}", out.focus_groups.len() + 1),
                                title: "Working…".to_string(),
                                explicit_focus: false,
                                started_at: step_ts.clone(),
                                ended_at: None,
                                steps: Vec::new(),
                            });
                        }
                        if let Some(grp) = out.focus_groups.last_mut() {
                            grp.steps.push(SessionStep {
                                id: call_id
                                    .clone()
                                    .unwrap_or_else(|| format!("tr-{}-{}", grp.id, grp.steps.len())),
                                call_id,
                                step_idx: None,
                                event: "Transcript".to_string(),
                                tool_name: Some(name.to_string()),
                                summary: meta.summary,
                                detail: meta.detail,
                                verb: meta.verb,
                                file_path: meta.file_path,
                                line_range: meta.line_range,
                                start_line: step_start_line,
                                added_lines: step_added,
                                removed_lines: step_removed,
                                status: "done".to_string(),
                                timestamp: step_ts.clone(),
                            });
                            if !grp.explicit_focus {
                                grp.title = auto_summarize_group_steps(&grp.steps);
                            }
                        }
                    }
                }
            }
        }
    }

    Some(out)
}

fn apply_insights_to_session(sess: &mut AgentSession, ins: TranscriptInsights) -> bool {
    let mut changed = false;
    if let Some(p) = ins.user_prompt {
        if sess.last_user_input.as_deref() != Some(p.as_str()) {
            sess.last_user_input = Some(p);
            changed = true;
        }
    }
    if let Some(m) = ins.model_name {
        if sess.model_name.as_deref() != Some(m.as_str()) {
            sess.model_name = Some(m);
            changed = true;
        }
    }
    if let Some(th) = ins.latest_thinking {
        if sess.latest_thinking.as_deref() != Some(th.as_str()) {
            sess.latest_thinking = Some(th);
            changed = true;
        }
    }
    if sess.latest_output != ins.latest_output {
        sess.latest_output = ins.latest_output;
        changed = true;
    }
    if sess.status == "active" || sess.status == "waiting_approval" {
        if sess.mid_process_note != ins.mid_process_note {
            sess.mid_process_note = ins.mid_process_note;
            changed = true;
        }
    } else if sess.mid_process_note.is_some() {
        sess.mid_process_note = None;
        changed = true;
    }
    if let Some(perm) = ins.detected_ide_permission {
        if sess.detected_ide_permission.as_deref() != Some(perm.as_str()) {
            sess.detected_ide_permission = Some(perm);
            changed = true;
        }
    }
    if let Some(f) = ins.current_focus {
        if sess.current_focus.as_deref() != Some(f.as_str()) {
            sess.current_focus = Some(f);
            changed = true;
        }
    } else if ins.has_explicit_turn && sess.current_focus.is_some() && sess.focus_groups.is_empty() {
        sess.current_focus = None;
        changed = true;
    }

    // Strictly match the current turn's `update_steps` — if this turn has no steps, clear stale ones!
    let next_steps = ins.plan_steps.unwrap_or_default();
    let same_steps = sess.plan_steps.len() == next_steps.len()
        && sess
            .plan_steps
            .iter()
            .zip(next_steps.iter())
            .all(|(a, b)| a.title == b.title && a.status == b.status);
    if !same_steps {
        sess.plan_steps = next_steps;
        changed = true;
    }

    if sess.focus_groups.is_empty() && !ins.focus_groups.is_empty() {
        sess.focus_groups = ins.focus_groups;
        changed = true;
    }
    if sess.diffs.is_empty() && !ins.diffs.is_empty() {
        sess.files_touched_count = ins.diffs.len();
        sess.diffs = ins.diffs.into_iter().rev().collect();
        changed = true;
    }
    changed
}

impl AppCore {
    pub fn new() -> Self {
        let data_dir = nova_data_dir();
        let store_path = data_dir.join("state.json");

        let persisted: PersistedStore = fs::read_to_string(&store_path)
            .ok()
            .and_then(|raw| serde_json::from_str(&raw).ok())
            .unwrap_or_default();

        let mut settings = persisted.settings;
        if settings.shortcuts.is_empty() {
            settings = NovaSettings::default();
        }
        annotate_altgr_conflicts(&mut settings.shortcuts);

        let personas = if persisted.personas.is_empty() {
            default_personas()
        } else {
            persisted.personas
        };

        let threads = if persisted.threads.is_empty() {
            vec![ChatThread {
                id: "thread-main".into(),
                title: "NOVA Quick Command Chat".into(),
                persona_id: "architect".into(),
                messages: vec![ChatMessage {
                    id: "welcome-1".into(),
                    role: "assistant".into(),
                    content: "NOVA Core online. Press `Ctrl+Alt+Space` anytime to search workspaces, inspect diffs, manage localhost ports, capture a screen snip, or chat in English / ภาษาไทย.".into(),
                    thinking: None,
                    provider: Some("nova".into()),
                    model: Some("system".into()),
                    image_data_url: None,
                    attached_file: None,
                    timestamp: chrono::Utc::now().to_rfc3339(),
                }],
                updated_at: chrono::Utc::now().to_rfc3339(),
            }]
        } else {
            persisted.threads
        };

        let tech_dictionary = if persisted.tech_dictionary.is_empty() {
            default_tech_dictionary()
        } else {
            persisted.tech_dictionary
        };

        let voice_snippets = if persisted.voice_snippets.is_empty() {
            default_voice_snippets()
        } else {
            persisted.voice_snippets
        };

        let ipc_token = ensure_token_file("ipc.token");
        let pairing_token = ensure_token_file("mobile.token");
        let lan_ip = local_lan_ipv4();

        let (events_tx, _) = broadcast::channel(128);
        let mut sys = System::new_all();
        sys.refresh_cpu_usage();
        sys.refresh_memory();

        let core = Self {
            inner: Arc::new(Mutex::new(InnerState {
                settings,
                sessions: Vec::new(),
                pending_approvals: Vec::new(),
                approval_waiters: HashMap::new(),
                pending_tool_diffs: HashMap::new(),
                bg_pids: HashMap::new(),
                approval_rules: persisted.approval_rules,
                threads,
                personas,
                clipboard_history: Vec::new(),
                tech_dictionary,
                voice_snippets,
                voice_notes: persisted.voice_notes,
                focus: persisted.focus,
                analytics: persisted.analytics,
                ipc_token,
                pairing_token,
                lan_ip,
            })),
            sys: Arc::new(Mutex::new(sys)),
            events_tx,
        };

        core.persist();
        core
    }

    pub fn persist(&self) {
        let store = {
            let guard = self.inner.lock().unwrap();
            PersistedStore {
                settings: guard.settings.clone(),
                approval_rules: guard.approval_rules.clone(),
                threads: guard.threads.clone(),
                personas: guard.personas.clone(),
                tech_dictionary: guard.tech_dictionary.clone(),
                voice_snippets: guard.voice_snippets.clone(),
                voice_notes: guard.voice_notes.clone(),
                focus: guard.focus.clone(),
                analytics: guard.analytics.clone(),
            }
        };
        if let Ok(raw) = serde_json::to_string_pretty(&store) {
            let tmp = nova_data_dir().join("state.json.tmp");
            let dst = nova_data_dir().join("state.json");
            if fs::write(&tmp, raw).is_ok() {
                let _ = fs::rename(&tmp, &dst);
            }
        }
    }

    pub fn snapshot(&self) -> NovaSnapshot {
        let guard = self.inner.lock().unwrap();
        let agy_hooks = inspect_antigravity_hooks(guard.settings.agy_approve_in_island);
        let secrets = secret_presence_map();
        let mobile = build_mobile_pairing_info(
            guard.settings.remote_lan_enabled,
            &guard.lan_ip,
            CORE_PORT,
            &guard.pairing_token,
            guard.settings.telegram_enabled,
        );

        let active_paths: Vec<String> = guard
            .sessions
            .iter()
            .map(|s| s.workspace_path.clone())
            .collect();
        let recent_workspaces = discover_recent_workspaces(&active_paths);
        let agy_cli_available = resolve_agy_cli_path().is_some();
        let detected_ide_permission = detect_antigravity_permission_mode(
            guard.sessions.first().map(|s| s.workspace_path.as_str()),
        );
        let mut sessions_out = guard.sessions.clone();
        for s in &mut sessions_out {
            if s.detected_ide_permission.is_none() {
                s.detected_ide_permission = detected_ide_permission.clone();
            }
        }

        NovaSnapshot {
            version: env!("CARGO_PKG_VERSION").to_string(),
            settings: guard.settings.clone(),
            sessions: sessions_out,
            pending_approvals: guard.pending_approvals.clone(),
            approval_rules: guard.approval_rules.clone(),
            threads: guard.threads.clone(),
            personas: guard.personas.clone(),
            clipboard_history: guard.clipboard_history.clone(),
            tech_dictionary: guard.tech_dictionary.clone(),
            voice_snippets: guard.voice_snippets.clone(),
            voice_notes: guard.voice_notes.clone(),
            focus: guard.focus.clone(),
            analytics: guard.analytics.clone(),
            agy_hooks,
            secrets,
            mobile,
            recent_workspaces,
            agy_cli_available,
            detected_ide_permission,
        }
    }

    pub fn broadcast_snapshot(&self, sound_cue: Option<&str>) {
        let snap = self.snapshot();
        let _ = self.events_tx.send(json!({
            "type": "snapshot",
            "sound": sound_cue,
            "data": snap
        }));
    }

    pub fn start_background_loops(&self) {
        // 1. Novadoro Focus Timer 1s loop
        let focus_core = self.clone();
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(std::time::Duration::from_secs(1));
            loop {
                interval.tick().await;
                let mut completed_cue = false;
                let mut changed = false;
                {
                    let mut g = focus_core.inner.lock().unwrap();
                    if g.focus.running {
                        changed = true;
                        if g.focus.remaining_sec > 1 {
                            g.focus.remaining_sec -= 1;
                        } else {
                            g.focus.running = false;
                            g.focus.remaining_sec = 0;
                            completed_cue = true;
                            if g.focus.mode == "focus" {
                                let mins = (g.focus.total_sec / 60).max(1);
                                g.focus.completed_blocks_today += 1;
                                g.focus.total_focus_minutes += mins;
                                g.analytics.focus_minutes += mins;
                            }
                        }
                    }
                }
                if completed_cue {
                    focus_core.persist();
                    focus_core.broadcast_snapshot(Some("focus_complete"));
                } else if changed {
                    let f = focus_core.inner.lock().unwrap().focus.clone();
                    let _ = focus_core.events_tx.send(json!({
                        "type": "focus_tick",
                        "data": f
                    }));
                }
            }
        });

        // 2. Smart Clipboard History Watcher (every 2.5s)
        let cb_core = self.clone();
        tokio::spawn(async move {
            let mut last_seen = String::new();
            let mut interval = tokio::time::interval(std::time::Duration::from_millis(2500));
            loop {
                interval.tick().await;
                let Some(text) = tokio::task::spawn_blocking(read_clipboard_text)
                    .await
                    .ok()
                    .flatten()
                else {
                    continue;
                };
                let trimmed = text.trim();
                if trimmed.is_empty() || trimmed == last_seen || trimmed.len() > 24_000 {
                    continue;
                }
                last_seen = trimmed.to_string();

                let kind = if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
                    "url"
                } else if trimmed.contains(":\\") || trimmed.starts_with('/') {
                    "path"
                } else if trimmed.contains('{')
                    || trimmed.contains("const ")
                    || trimmed.contains("fn ")
                    || trimmed.contains("import ")
                {
                    "code"
                } else {
                    "text"
                };

                let preview: String = trimmed.chars().take(140).collect();
                let mut added = false;
                {
                    let mut g = cb_core.inner.lock().unwrap();
                    if !g.clipboard_history.iter().any(|c| c.content == trimmed) {
                        g.clipboard_history.insert(
                            0,
                            ClipboardEntry {
                                id: uuid::Uuid::new_v4().to_string(),
                                kind: kind.to_string(),
                                content: trimmed.to_string(),
                                preview,
                                pinned: false,
                                timestamp: chrono::Utc::now().to_rfc3339(),
                            },
                        );
                        if g.clipboard_history.len() > 35 {
                            g.clipboard_history.retain(|c| c.pinned);
                            while g.clipboard_history.len() > 35 {
                                g.clipboard_history.pop();
                            }
                        }
                        added = true;
                    }
                }
                if added {
                    cb_core.broadcast_snapshot(None);
                }
            }
        });

        // 3. Telegram Inline Callback Poller (when enabled)
        let tg_core = self.clone();
        tokio::spawn(async move {
            let mut offset: i64 = 0;
            let client = reqwest::Client::new();
            loop {
                tokio::time::sleep(std::time::Duration::from_secs(3)).await;
                let enabled = tg_core.inner.lock().unwrap().settings.telegram_enabled;
                if !enabled {
                    continue;
                }
                let Some(token) = crate::ai_services::get_secret("telegram_token") else {
                    continue;
                };
                let url = format!(
                    "https://api.telegram.org/bot{token}/getUpdates?offset={offset}&timeout=1"
                );
                let Ok(resp) = client.get(&url).send().await else {
                    continue;
                };
                let Ok(val) = resp.json::<Value>().await else {
                    continue;
                };
                for item in val["result"].as_array().cloned().unwrap_or_default() {
                    if let Some(uid) = item["update_id"].as_i64() {
                        offset = uid + 1;
                    }
                    if let Some(cb_data) = item["callback_query"]["data"].as_str() {
                        if let Some((act, app_id)) = cb_data.split_once(':') {
                            let decision = if act == "allow" { "allow" } else { "deny" };
                            let _ = tg_core.resolve_approval(app_id, decision, None, None, None);
                        }
                    }
                }
            }
        });

        // 4. Live Transcript Tail Watcher (1.1s, zero cost when file size unchanged)
        let tr_core = self.clone();
        tokio::spawn(async move {
            let mut last_sizes: HashMap<String, u64> = HashMap::new();
            let mut interval = tokio::time::interval(std::time::Duration::from_millis(1100));
            loop {
                interval.tick().await;
                let targets: Vec<(String, String)> = {
                    let g = tr_core.inner.lock().unwrap();
                    g.sessions
                        .iter()
                        .take(6)
                        .filter_map(|s| {
                            let tp = s.transcript_path.as_ref()?.clone();
                            Some((s.conversation_id.clone(), tp))
                        })
                        .collect()
                };

                if targets.is_empty() {
                    continue;
                }

                let mut updates: Vec<(String, TranscriptInsights)> = Vec::new();
                for (cid, tp) in targets {
                    let Ok(meta) = fs::metadata(&tp) else {
                        continue;
                    };
                    let len = meta.len();
                    if last_sizes.get(&tp).copied() == Some(len) {
                        continue;
                    }
                    last_sizes.insert(tp.clone(), len);
                    if let Ok(Some(ins)) =
                        tokio::task::spawn_blocking(move || read_transcript_insights(&tp)).await
                    {
                        updates.push((cid, ins));
                    }
                }

                if updates.is_empty() {
                    continue;
                }

                let mut any_changed = false;
                {
                    let mut g = tr_core.inner.lock().unwrap();
                    for (cid, ins) in updates {
                        if let Some(sess) =
                            g.sessions.iter_mut().find(|s| s.conversation_id == cid)
                        {
                            if apply_insights_to_session(sess, ins) {
                                any_changed = true;
                            }
                        }
                    }
                }

                if any_changed {
                    tr_core.broadcast_snapshot(None);
                }
            }
        });
    }

    /// Processes a normalized hook event from `nova-hook.exe`.
    pub async fn handle_hook_event(&self, env: NormalizedHookEnvelope) -> HookRelayResponse {
        let now = chrono::Utc::now().to_rfc3339();
        let workspace_name = Path::new(&env.workspace_path)
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| env.workspace_path.clone());

        let tool_name = env.tool_name.clone().unwrap_or_default();
        let formatted_step = format_tool_step(
            &tool_name,
            &env.tool_args,
            env.command_line.as_deref(),
            env.target_file.as_deref(),
        );
        let focus_override = if tool_name == "update_focus" {
            extract_focus_phrase(&env.tool_args)
        } else {
            None
        };
        let steps_override = if tool_name == "update_steps" {
            extract_plan_steps(&env.tool_args)
        } else {
            None
        };

        let resolved_transcript = discover_transcript_path(
            &env.conversation_id,
            env.transcript_path.as_deref(),
            &env.raw_payload,
        );
        let transcript_insights = if let Some(tp) = resolved_transcript.clone() {
            tokio::task::spawn_blocking(move || read_transcript_insights(&tp))
                .await
                .ok()
                .flatten()
        } else {
            None
        };

        let cleaned_prompt = env
            .last_user_input
            .as_deref()
            .and_then(clean_user_prompt);
        let cleaned_model = env
            .model_name
            .as_deref()
            .and_then(humanize_model_name);

        let diff_preview = build_file_diff_preview(
            &tool_name,
            env.target_file.as_deref(),
            &env.tool_args,
        );

        let ev_lower = env.event.to_ascii_lowercase();
        let is_pre_tool = ev_lower == "pretooluse" || ev_lower == "beforetool";
        let is_post_tool = ev_lower == "posttooluse" || ev_lower == "aftertool";
        let is_pre_inv = ev_lower == "preinvocation";
        let is_post_inv = ev_lower == "postinvocation";
        let is_stop = ev_lower == "stop";
        let has_error = env.error.as_deref().is_some_and(|e| !e.trim().is_empty());

        // Update session Mission Control state + evaluate two-way control & permission gate
        let (
            immediate_hook_reply,
            matched_rule_action,
            auto_safe_pass,
            effective_perm_mode,
            detected_ide_perm,
            guard_critical_in_follow,
            agy_approve_enabled,
            telegram_enabled,
            risk,
        ) = {
            let mut g = self.inner.lock().unwrap();
            let diff_key = env
                .tool_call_id
                .clone()
                .unwrap_or_else(|| format!("{}:{}", env.conversation_id, tool_name));
            if is_pre_tool {
                if let Some(ref dp) = diff_preview {
                    g.pending_tool_diffs.insert(diff_key.clone(), dp.clone());
                }
            }
            let effective_diff = if is_post_tool {
                g.pending_tool_diffs
                    .remove(&diff_key)
                    .or_else(|| diff_preview.clone())
            } else {
                diff_preview.clone()
            };

            let risk = assess_tool_risk(
                &tool_name,
                env.command_line.as_deref(),
                env.target_file.as_deref(),
            );
            let ide_perm_live = detect_antigravity_permission_mode(Some(&env.workspace_path));

            // Reconcile optimistic `pending-*` or linked CLI headless session with its real Antigravity UUID
            let session_pos = g
                .sessions
                .iter()
                .position(|s| {
                    s.conversation_id == env.conversation_id
                        || s.cli_conversation_id.as_deref() == Some(env.conversation_id.as_str())
                })
                .or_else(|| {
                    g.sessions.iter().position(|s| {
                        s.conversation_id.starts_with("pending-")
                            && s.workspace_path
                                .trim_end_matches(['\\', '/'])
                                .eq_ignore_ascii_case(
                                    env.workspace_path.trim_end_matches(['\\', '/']),
                                )
                    })
                });

            let idx = if let Some(pos) = session_pos {
                let old_id = g.sessions[pos].conversation_id.clone();
                if old_id.starts_with("pending-") && old_id != env.conversation_id {
                    g.sessions[pos].conversation_id = env.conversation_id.clone();
                    g.sessions[pos].cli_conversation_id = Some(env.conversation_id.clone());
                    if let Some(pid) = g.bg_pids.remove(&old_id) {
                        g.bg_pids.insert(env.conversation_id.clone(), pid);
                    }
                }
                pos
            } else {
                g.analytics.total_sessions += 1;
                *g.analytics
                    .top_workspaces
                    .entry(workspace_name.clone())
                    .or_insert(0) += 1;
                g.sessions.insert(
                    0,
                    AgentSession {
                        conversation_id: env.conversation_id.clone(),
                        agent: env.agent.clone(),
                        workspace_path: env.workspace_path.clone(),
                        workspace_name: workspace_name.clone(),
                        git_branch: env.git_branch.clone(),
                        model_name: cleaned_model.clone(),
                        last_user_input: cleaned_prompt.clone(),
                        status: "active".into(),
                        phase: "thinking".into(),
                        current_focus: None,
                        mid_process_note: None,
                        latest_thinking: None,
                        latest_output: None,
                        plan_steps: Vec::new(),
                        focus_groups: Vec::new(),
                        transcript_path: resolved_transcript.clone(),
                        queued_messages: Vec::new(),
                        stop_requested: false,
                        bg_running: false,
                        cli_conversation_id: None,
                        last_error: None,
                        detected_ide_permission: ide_perm_live.clone(),
                        permission_override: None,
                        active_tool: None,
                        steps: Vec::new(),
                        diffs: Vec::new(),
                        subagents: Vec::new(),
                        process_chain: env.process_chain.clone(),
                        started_at: now.clone(),
                        updated_at: now.clone(),
                        commands_count: 0,
                        files_touched_count: 0,
                    },
                );
                0
            };

            let mut early_reply: Option<HookRelayResponse> = None;
            let sess_perm_override: Option<String>;

            {
                let sess = &mut g.sessions[idx];
                sess.updated_at = now.clone();
                if ide_perm_live.is_some() {
                    sess.detected_ide_permission = ide_perm_live.clone();
                }
                if env.git_branch.is_some() {
                    sess.git_branch = env.git_branch.clone();
                }
                if let Some(m) = &cleaned_model {
                    sess.model_name = Some(m.clone());
                }
                if let Some(p) = &cleaned_prompt {
                    if sess.last_user_input.as_deref() != Some(p.as_str()) {
                        sess.last_user_input = Some(p.clone());
                        sess.latest_output = None;
                        sess.last_error = None;
                        sess.mid_process_note = None;
                        sess.current_focus = None;
                        sess.plan_steps.clear();
                        sess.focus_groups.clear();
                        sess.steps.clear();
                        sess.diffs.clear();
                    }
                }
                if resolved_transcript.is_some() {
                    sess.transcript_path = resolved_transcript.clone();
                }
                if let Some(ins) = transcript_insights {
                    let _ = apply_insights_to_session(sess, ins);
                }
                if let Some(f) = focus_override {
                    sess.current_focus = Some(f.clone());
                    if is_pre_tool {
                        let promoted = if let Some(last_grp) = sess.focus_groups.last_mut() {
                            if !last_grp.explicit_focus && last_grp.steps.len() <= 2 {
                                last_grp.title = f.clone();
                                last_grp.explicit_focus = true;
                                true
                            } else if last_grp.steps.is_empty() {
                                last_grp.title = f.clone();
                                last_grp.explicit_focus = true;
                                last_grp.started_at = now.clone();
                                true
                            } else {
                                if last_grp.ended_at.is_none() {
                                    last_grp.ended_at = Some(now.clone());
                                }
                                false
                            }
                        } else {
                            false
                        };
                        if !promoted {
                            sess.focus_groups.push(FocusGroup {
                                id: uuid::Uuid::new_v4().to_string(),
                                title: f,
                                explicit_focus: true,
                                started_at: now.clone(),
                                ended_at: None,
                                steps: Vec::new(),
                            });
                            if sess.focus_groups.len() > 24 {
                                sess.focus_groups.remove(0);
                            }
                        }
                    }
                }
                if let Some(ps) = steps_override {
                    sess.plan_steps = ps;
                }
                if !env.process_chain.is_empty() {
                    sess.process_chain = env.process_chain.clone();
                }
                if let Some(role) = &env.subagent_role {
                    if !sess.subagents.iter().any(|sa| sa.role == *role) {
                        sess.subagents.push(SubagentNode {
                            id: uuid::Uuid::new_v4().to_string(),
                            role: role.clone(),
                            status: "running".into(),
                            started_at: now.clone(),
                        });
                    }
                }

                // 1. Honor Stop Request from NOVA Island
                if sess.stop_requested {
                    if is_pre_tool {
                        sess.stop_requested = false;
                        sess.status = "completed".into();
                        sess.phase = "done".into();
                        sess.active_tool = None;
                        sess.mid_process_note = None;
                        early_reply = Some(HookRelayResponse {
                            decision: Some("deny".into()),
                            reason: Some("Session stopped by user from NOVA Island.".into()),
                            ..Default::default()
                        });
                    } else if is_pre_inv || is_post_inv {
                        sess.stop_requested = false;
                        sess.status = "completed".into();
                        sess.phase = "done".into();
                        sess.active_tool = None;
                        sess.mid_process_note = None;
                        early_reply = Some(HookRelayResponse {
                            termination_behavior: Some("terminate".into()),
                            inject_error_message: Some(
                                "User stopped this run from NOVA Island.".into(),
                            ),
                            ..Default::default()
                        });
                    } else if is_stop {
                        sess.stop_requested = false;
                    }
                }

                // 2. Inject Mid-Run Queued Steering Messages via PreInvocation / PostInvocation / Stop
                if early_reply.is_none() && !sess.queued_messages.is_empty() {
                    if is_pre_inv || is_post_inv {
                        let joined = sess.queued_messages.drain(..).collect::<Vec<_>>().join("\n\n");
                        sess.last_user_input = Some(truncate_chars(&joined, 240));
                        sess.status = "active".into();
                        sess.phase = "thinking".into();
                        early_reply = Some(HookRelayResponse {
                            inject_user_message: Some(joined),
                            termination_behavior: Some("force_continue".into()),
                            ..Default::default()
                        });
                    } else if is_stop {
                        let joined = sess.queued_messages.drain(..).collect::<Vec<_>>().join("\n\n");
                        sess.last_user_input = Some(truncate_chars(&joined, 240));
                        sess.status = "active".into();
                        sess.phase = "thinking".into();
                        early_reply = Some(HookRelayResponse {
                            decision: Some("continue".into()),
                            reason: Some(joined),
                            ..Default::default()
                        });
                    }
                }

                if early_reply.is_none() {
                    if is_stop {
                        let is_err_stop = has_error
                            || env
                                .termination_reason
                                .as_deref()
                                .is_some_and(|r| r.eq_ignore_ascii_case("ERROR"));
                        sess.status = if is_err_stop {
                            "error".into()
                        } else {
                            "completed".into()
                        };
                        sess.phase = if is_err_stop {
                            "error".into()
                        } else {
                            "done".into()
                        };
                        sess.active_tool = None;
                        sess.mid_process_note = None;
                        sess.bg_running = false;
                        for st in &mut sess.steps {
                            if st.status == "running" {
                                st.status = "done".into();
                            }
                        }
                        for fg in &mut sess.focus_groups {
                            if fg.ended_at.is_none() {
                                fg.ended_at = Some(now.clone());
                            }
                            for st in &mut fg.steps {
                                if st.status == "running" {
                                    st.status = "done".into();
                                }
                            }
                        }
                        for sa in &mut sess.subagents {
                            sa.status = "completed".into();
                        }
                    } else if is_pre_inv || is_post_inv {
                        sess.status = "active".into();
                        sess.phase = "thinking".into();
                        sess.active_tool = None;
                    } else if is_pre_tool {
                        sess.status = "active".into();
                        sess.phase = "working".into();
                        if let Some(ref meta) = formatted_step {
                            sess.active_tool = Some(format!("{} {}", meta.verb, meta.summary));
                        }
                    } else if is_post_tool {
                        sess.status = "active".into();
                        sess.phase = "thinking".into();
                        sess.active_tool = None;
                    } else {
                        sess.status = "active".into();
                    }
                }

                if env.command_line.is_some() && is_pre_tool {
                    sess.commands_count += 1;
                }

                // Deduplicated in-place IDE action step tracking
                if let Some(meta) = formatted_step {
                    let step_added = effective_diff.as_ref().map(|d| d.added_lines);
                    let step_removed = effective_diff.as_ref().map(|d| d.removed_lines);
                    let step_start_line = effective_diff
                        .as_ref()
                        .and_then(|d| d.start_line)
                        .or(meta.start_line);

                    if is_pre_tool {
                        let already_tracked = env.tool_call_id.as_ref().is_some_and(|cid| {
                            sess.steps.iter().any(|st| st.call_id.as_ref() == Some(cid))
                        });
                        if !already_tracked {
                            let new_step = SessionStep {
                                id: uuid::Uuid::new_v4().to_string(),
                                call_id: env.tool_call_id.clone(),
                                step_idx: env.step_idx,
                                event: env.event.clone(),
                                tool_name: env.tool_name.clone(),
                                summary: meta.summary,
                                detail: meta.detail,
                                verb: meta.verb,
                                file_path: meta.file_path,
                                line_range: meta.line_range,
                                start_line: step_start_line,
                                added_lines: step_added,
                                removed_lines: step_removed,
                                status: "running".into(),
                                timestamp: now.clone(),
                            };
                            sess.steps.insert(0, new_step.clone());
                            sess.steps.truncate(60);

                            // Append to active 2-layer FocusGroup (or create auto-summarized group)
                            let need_group = sess
                                .focus_groups
                                .last()
                                .is_none_or(|g| g.ended_at.is_some());
                            if need_group {
                                let fallback_title = sess
                                    .current_focus
                                    .clone()
                                    .unwrap_or_else(|| "Working…".to_string());
                                let is_exp = sess.current_focus.is_some();
                                sess.focus_groups.push(FocusGroup {
                                    id: uuid::Uuid::new_v4().to_string(),
                                    title: fallback_title,
                                    explicit_focus: is_exp,
                                    started_at: now.clone(),
                                    ended_at: None,
                                    steps: Vec::new(),
                                });
                            }
                            if let Some(grp) = sess.focus_groups.last_mut() {
                                grp.steps.push(new_step);
                                if grp.steps.len() > 50 {
                                    grp.steps.remove(0);
                                }
                                if !grp.explicit_focus {
                                    grp.title = auto_summarize_group_steps(&grp.steps);
                                }
                            }
                        }
                    } else if is_post_tool {
                        let existing_pos = if let Some(ref cid) = env.tool_call_id {
                            sess.steps
                                .iter()
                                .position(|st| st.call_id.as_ref() == Some(cid))
                        } else {
                            None
                        }
                        .or_else(|| {
                            sess.steps.iter().position(|st| {
                                st.status == "running"
                                    && st.tool_name.as_deref() == Some(tool_name.as_str())
                            })
                        });

                        let final_status = if has_error { "error" } else { "done" };
                        let final_detail = if has_error {
                            env.error
                                .as_deref()
                                .map(|e| truncate_chars(e, 110))
                                .or(meta.detail)
                        } else {
                            meta.detail
                        };

                        if let Some(pos) = existing_pos {
                            sess.steps[pos].status = final_status.into();
                            if final_detail.is_some() {
                                sess.steps[pos].detail = final_detail.clone();
                            }
                            if step_added.is_some() {
                                sess.steps[pos].added_lines = step_added;
                                sess.steps[pos].removed_lines = step_removed;
                            }
                            if step_start_line.is_some() {
                                sess.steps[pos].start_line = step_start_line;
                            }
                            sess.steps[pos].timestamp = now.clone();
                        } else {
                            sess.steps.insert(
                                0,
                                SessionStep {
                                    id: uuid::Uuid::new_v4().to_string(),
                                    call_id: env.tool_call_id.clone(),
                                    step_idx: env.step_idx,
                                    event: env.event.clone(),
                                    tool_name: env.tool_name.clone(),
                                    summary: meta.summary.clone(),
                                    detail: final_detail.clone(),
                                    verb: meta.verb.clone(),
                                    file_path: meta.file_path.clone(),
                                    line_range: meta.line_range.clone(),
                                    start_line: step_start_line,
                                    added_lines: step_added,
                                    removed_lines: step_removed,
                                    status: final_status.into(),
                                    timestamp: now.clone(),
                                },
                            );
                            sess.steps.truncate(60);
                        }

                        // Update matching step in `focus_groups` in-place
                        let mut updated_in_group = false;
                        for grp in sess.focus_groups.iter_mut().rev() {
                            let gpos = if let Some(ref cid) = env.tool_call_id {
                                grp.steps
                                    .iter()
                                    .position(|st| st.call_id.as_ref() == Some(cid))
                            } else {
                                None
                            }
                            .or_else(|| {
                                grp.steps.iter().rposition(|st| {
                                    st.status == "running"
                                        && st.tool_name.as_deref() == Some(tool_name.as_str())
                                })
                            });

                            if let Some(gp) = gpos {
                                grp.steps[gp].status = final_status.into();
                                if final_detail.is_some() {
                                    grp.steps[gp].detail = final_detail.clone();
                                }
                                if step_added.is_some() {
                                    grp.steps[gp].added_lines = step_added;
                                    grp.steps[gp].removed_lines = step_removed;
                                }
                                if step_start_line.is_some() {
                                    grp.steps[gp].start_line = step_start_line;
                                }
                                grp.steps[gp].timestamp = now.clone();
                                updated_in_group = true;
                                break;
                            }
                        }

                        if !updated_in_group {
                            if sess
                                .focus_groups
                                .last()
                                .is_none_or(|g| g.ended_at.is_some())
                            {
                                sess.focus_groups.push(FocusGroup {
                                    id: uuid::Uuid::new_v4().to_string(),
                                    title: "Working…".to_string(),
                                    explicit_focus: false,
                                    started_at: now.clone(),
                                    ended_at: None,
                                    steps: Vec::new(),
                                });
                            }
                            if let Some(grp) = sess.focus_groups.last_mut() {
                                grp.steps.push(SessionStep {
                                    id: uuid::Uuid::new_v4().to_string(),
                                    call_id: env.tool_call_id.clone(),
                                    step_idx: env.step_idx,
                                    event: env.event.clone(),
                                    tool_name: env.tool_name.clone(),
                                    summary: meta.summary,
                                    detail: final_detail,
                                    verb: meta.verb,
                                    file_path: meta.file_path,
                                    line_range: meta.line_range,
                                    start_line: step_start_line,
                                    added_lines: step_added,
                                    removed_lines: step_removed,
                                    status: final_status.into(),
                                    timestamp: now.clone(),
                                });
                                if !grp.explicit_focus {
                                    grp.title = auto_summarize_group_steps(&grp.steps);
                                }
                            }
                        }
                    }
                }

                if let Some(dp) = &effective_diff {
                    if is_post_tool && !has_error {
                        sess.files_touched_count += 1;
                        sess.diffs.insert(0, dp.clone());
                        sess.diffs.truncate(60);
                    }
                }

                sess_perm_override = sess.permission_override.clone();
            }

            if is_stop && early_reply.is_none() {
                g.bg_pids.remove(&env.conversation_id);
            }

            if env.command_line.is_some() && is_pre_tool {
                g.analytics.total_commands_inspected += 1;
            }
            if let Some(dp) = &effective_diff {
                if is_post_tool && !has_error {
                    g.analytics.files_edited += 1;
                    g.analytics.lines_added += dp.added_lines;
                    g.analytics.lines_removed += dp.removed_lines;
                }
            }

            // Evaluate custom Approval Rules
            let candidate_str = env
                .command_line
                .as_deref()
                .or(env.target_file.as_deref())
                .unwrap_or(&tool_name);

            let matched_rule_action = g
                .approval_rules
                .iter()
                .find(|rule| {
                    let tool_ok = rule.tool_matcher == "*" || rule.tool_matcher == tool_name;
                    let scope_ok = match rule.scope.as_str() {
                        "session" => rule.scope_target.as_deref() == Some(&env.conversation_id),
                        "workspace" => rule.scope_target.as_deref() == Some(&env.workspace_path),
                        _ => true,
                    };
                    let pat_ok = candidate_str
                        .to_ascii_lowercase()
                        .contains(&rule.pattern.to_ascii_lowercase());
                    tool_ok && scope_ok && pat_ok
                })
                .map(|r| r.action.clone());

            let auto_safe_pass = g.settings.auto_approve_safe_reads && risk.level == "safe";
            let effective_perm = sess_perm_override
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| g.settings.permission_mode.clone());
            (
                early_reply,
                matched_rule_action,
                auto_safe_pass,
                effective_perm,
                ide_perm_live,
                g.settings.guard_critical_in_follow,
                g.settings.agy_approve_in_island,
                g.settings.telegram_enabled,
                risk,
            )
        };

        if let Some(reply) = immediate_hook_reply {
            self.persist();
            self.broadcast_snapshot(Some("step"));
            return reply;
        }

        if is_stop {
            if let Some(tp) = resolved_transcript {
                let stop_core = self.clone();
                let stop_cid = env.conversation_id.clone();
                tokio::spawn(async move {
                    tokio::time::sleep(std::time::Duration::from_millis(220)).await;
                    if let Ok(Some(ins)) =
                        tokio::task::spawn_blocking(move || read_transcript_insights(&tp)).await
                    {
                        let mut changed = false;
                        {
                            let mut g = stop_core.inner.lock().unwrap();
                            if let Some(sess) = g.sessions.iter_mut().find(|s| {
                                s.conversation_id == stop_cid
                                    || s.cli_conversation_id.as_deref() == Some(stop_cid.as_str())
                            }) {
                                changed = apply_insights_to_session(sess, ins);
                            }
                        }
                        if changed {
                            stop_core.broadcast_snapshot(None);
                        }
                    }
                });
            }
            self.persist();
            self.broadcast_snapshot(Some("ready"));
            return HookRelayResponse::default();
        }

        if !is_pre_tool {
            self.broadcast_snapshot(None);
            return HookRelayResponse::default();
        }

        // PreToolUse decision pipeline
        // 1. Custom Scoped Approval Rules always take top precedence
        if let Some(rule_act) = matched_rule_action {
            if rule_act == "allow" {
                self.inner.lock().unwrap().analytics.approvals_auto_passed += 1;
                self.broadcast_snapshot(None);
                return HookRelayResponse {
                    decision: Some("allow".into()),
                    reason: Some("Matched NOVA approval rule".into()),
                    ..Default::default()
                };
            } else if rule_act == "deny" {
                self.inner.lock().unwrap().analytics.approvals_denied += 1;
                self.broadcast_snapshot(Some("denied"));
                return HookRelayResponse {
                    decision: Some("deny".into()),
                    reason: Some("Blocked by NOVA deny rule".into()),
                    ..Default::default()
                };
            }
        }

        // 2. Permission Mode Integration (`follow_agy` | `turbo` | `smart_auto` | `request_review`)
        let mode_norm = effective_perm_mode.trim().to_ascii_lowercase();
        let requires_interactive_card = if !agy_approve_enabled {
            false
        } else {
            match mode_norm.as_str() {
                "turbo" => {
                    self.inner.lock().unwrap().analytics.approvals_auto_passed += 1;
                    self.broadcast_snapshot(None);
                    return HookRelayResponse {
                        decision: Some("allow".into()),
                        ..Default::default()
                    };
                }
                "smart_auto" => {
                    if risk.score < 40 {
                        self.inner.lock().unwrap().analytics.approvals_auto_passed += 1;
                        self.broadcast_snapshot(None);
                        return HookRelayResponse {
                            decision: Some("allow".into()),
                            ..Default::default()
                        };
                    }
                    true
                }
                "request_review" => {
                    if auto_safe_pass && env.command_line.is_none() {
                        self.inner.lock().unwrap().analytics.approvals_auto_passed += 1;
                        self.broadcast_snapshot(None);
                        return HookRelayResponse {
                            decision: Some("allow".into()),
                            ..Default::default()
                        };
                    }
                    env.command_line.is_some()
                        || risk.score >= 25
                        || matches!(tool_name.as_str(), "run_command" | "Bash")
                }
                // Default: `"follow_agy"` — instant 0ms passthrough (`"ask"`) so Antigravity IDE's
                // own Turbo / Auto / Review setting governs without unwanted NOVA popups!
                // When Antigravity IDE is detected in Turbo mode, NEVER interrupt with a NOVA popup.
                _ => {
                    let ide_is_turbo = detected_ide_perm
                        .as_deref()
                        .is_some_and(|p| p.eq_ignore_ascii_case("turbo"));
                    if ide_is_turbo {
                        false
                    } else {
                        guard_critical_in_follow && risk.score >= 90
                    }
                }
            }
        };

        if !requires_interactive_card {
            self.broadcast_snapshot(None);
            return HookRelayResponse {
                decision: Some("ask".into()),
                ..Default::default()
            };
        }

        let approval_id = uuid::Uuid::new_v4().to_string();
        let (tx, rx) = oneshot::channel::<HookRelayResponse>();

        let detail_for_tg = env
            .command_line
            .clone()
            .or_else(|| env.target_file.clone())
            .unwrap_or_else(|| tool_name.clone());
        let risk_level_for_tg = risk.level.clone();

        {
            let mut g = self.inner.lock().unwrap();
            if let Some(sess) = g
                .sessions
                .iter_mut()
                .find(|s| s.conversation_id == env.conversation_id)
            {
                sess.status = "waiting_approval".into();
                sess.phase = "waiting_approval".into();
                if let Some(st) = sess.steps.first_mut() {
                    if st.status == "running" {
                        st.status = "waiting".into();
                    }
                }
            }
            g.pending_approvals.insert(
                0,
                PendingApproval {
                    id: approval_id.clone(),
                    conversation_id: env.conversation_id.clone(),
                    agent: env.agent.clone(),
                    workspace_path: env.workspace_path.clone(),
                    workspace_name: workspace_name.clone(),
                    git_branch: env.git_branch.clone(),
                    tool_name: tool_name.clone(),
                    command_line: env.command_line.clone(),
                    target_file: env.target_file.clone(),
                    tool_args: env.tool_args.clone(),
                    risk,
                    diff_preview,
                    created_at: now,
                    expires_in_sec: 108,
                },
            );
            g.approval_waiters.insert(approval_id.clone(), tx);
        }

        self.broadcast_snapshot(Some("approval_needed"));

        if telegram_enabled {
            let aid = approval_id.clone();
            let wname = workspace_name.clone();
            let tname = tool_name.clone();
            tokio::spawn(async move {
                send_telegram_approval_alert(&aid, &wname, &tname, &detail_for_tg, &risk_level_for_tg).await;
            });
        }

        match tokio::time::timeout(std::time::Duration::from_secs(108), rx).await {
            Ok(Ok(reply)) => reply,
            _ => {
                // Timed out or dropped -> clean up card and fall back to terminal/IDE prompt
                {
                    let mut g = self.inner.lock().unwrap();
                    g.pending_approvals.retain(|p| p.id != approval_id);
                    g.approval_waiters.remove(&approval_id);
                    if let Some(sess) = g
                        .sessions
                        .iter_mut()
                        .find(|s| s.conversation_id == env.conversation_id)
                    {
                        sess.status = "active".into();
                    }
                }
                self.broadcast_snapshot(None);
                HookRelayResponse {
                    decision: Some("ask".into()),
                    ..Default::default()
                }
            }
        }
    }

    pub fn resolve_approval(
        &self,
        approval_id: &str,
        decision: &str, // "allow" | "deny" | "ask"
        create_rule_scope: Option<&str>, // Some("session") | Some("workspace") | Some("global")
        edited_command: Option<&str>,
        deny_reason: Option<&str>,
    ) -> Result<(), String> {
        let mut sound_cue = None;
        {
            let mut g = self.inner.lock().unwrap();
            let pos = g
                .pending_approvals
                .iter()
                .position(|p| p.id == approval_id)
                .ok_or_else(|| "Approval request already settled or expired".to_string())?;

            let pending = g.pending_approvals.remove(pos);

            if let Some(scope) = create_rule_scope {
                if let Some(pat) = pending
                    .risk
                    .suggested_rule_pattern
                    .clone()
                    .or_else(|| pending.command_line.clone())
                {
                    let scope_target = match scope {
                        "session" => Some(pending.conversation_id.clone()),
                        "workspace" => Some(pending.workspace_path.clone()),
                        _ => None,
                    };
                    g.approval_rules.insert(
                        0,
                        ApprovalRule {
                            id: uuid::Uuid::new_v4().to_string(),
                            action: if decision == "deny" { "deny" } else { "allow" }.into(),
                            scope: scope.to_string(),
                            scope_target,
                            tool_matcher: pending.tool_name.clone(),
                            pattern: pat.clone(),
                            label: format!(
                                "{} `{}` ({})",
                                if decision == "deny" { "Block" } else { "Allow" },
                                pat,
                                scope
                            ),
                            created_at: chrono::Utc::now().to_rfc3339(),
                        },
                    );
                }
            }

            match decision {
                "allow" => {
                    g.analytics.approvals_allowed += 1;
                    sound_cue = Some("approved");
                }
                "deny" => {
                    g.analytics.approvals_denied += 1;
                    sound_cue = Some("denied");
                }
                _ => {}
            }

            if let Some(sess) = g
                .sessions
                .iter_mut()
                .find(|s| s.conversation_id == pending.conversation_id)
            {
                sess.status = "active".into();
                sess.phase = "working".into();
                for st in &mut sess.steps {
                    if st.status == "waiting" {
                        st.status = if decision == "deny" { "error" } else { "running" }.into();
                    }
                }
            }

            let overwrite_payload = if decision == "allow" {
                edited_command
                    .map(str::trim)
                    .filter(|c| !c.is_empty() && Some(*c) != pending.command_line.as_deref())
                    .map(|c| json!({ "CommandLine": c }))
            } else {
                None
            };

            let final_reason = if decision == "deny" {
                Some(
                    deny_reason
                        .map(str::trim)
                        .filter(|r| !r.is_empty())
                        .map(|r| format!("Denied from NOVA: {r}"))
                        .unwrap_or_else(|| "Denied from NOVA Mission Control".to_string()),
                )
            } else {
                None
            };

            if let Some(waiter) = g.approval_waiters.remove(approval_id) {
                let _ = waiter.send(HookRelayResponse {
                    decision: Some(decision.to_string()),
                    reason: final_reason,
                    overwrite: overwrite_payload,
                    ..Default::default()
                });
            }
        }

        self.persist();
        self.broadcast_snapshot(sound_cue);
        Ok(())
    }

    /// Sends a prompt to an active session (live hook injection) or launches/resumes a headless `agy.exe` turn.
    pub fn dispatch_agent_prompt(
        &self,
        workspace_path: &str,
        conversation_id: Option<&str>,
        prompt: &str,
        mode: Option<&str>,
        effort: Option<&str>,
        image_data_url: Option<&str>,
    ) -> Result<Value, String> {
        let mut final_prompt = prompt.trim().to_string();
        if let Some(durl) = image_data_url.map(str::trim).filter(|s| !s.is_empty()) {
            if let Some(snip_path) = save_snip_png_to_disk(durl) {
                let sp = snip_path.to_string_lossy();
                if final_prompt.is_empty() {
                    final_prompt = format!(
                        "Inspect the attached screenshot at `{sp}` using read_file and fix any visual or UI issue you find."
                    );
                } else {
                    final_prompt = format!(
                        "{final_prompt}\n\n[Attached Screenshot: `{sp}` — inspect this image file with read_file]"
                    );
                }
            }
        }

        if final_prompt.is_empty() {
            return Err("Prompt cannot be empty".to_string());
        }
        if final_prompt.len() > 16_000 {
            return Err("Prompt exceeds maximum length (16,000 chars)".to_string());
        }

        // 1. If targeting an active/running session, queue for live hook injection (`PostInvocation` / `Stop`)
        if let Some(cid) = conversation_id.map(str::trim).filter(|s| !s.is_empty()) {
            let mut queued_live = false;
            {
                let mut g = self.inner.lock().unwrap();
                if let Some(sess) = g.sessions.iter_mut().find(|s| s.conversation_id == cid) {
                    if sess.status == "active" || sess.status == "waiting_approval" {
                        sess.queued_messages.push(final_prompt.clone());
                        sess.updated_at = chrono::Utc::now().to_rfc3339();
                        queued_live = true;
                    }
                }
            }
            if queued_live {
                self.broadcast_snapshot(Some("step"));
                return Ok(json!({
                    "ok": true,
                    "delivery": "queued_hook",
                    "conversationId": cid
                }));
            }
        }

        // 2. Otherwise spawn/resume headless `agy.exe` silently in the background!
        let agy_exe = resolve_agy_cli_path()
            .ok_or_else(|| "Antigravity CLI (agy.exe) not found in %LOCALAPPDATA%\\agy\\bin".to_string())?;

        let resolved_ws = {
            let g = self.inner.lock().unwrap();
            if !workspace_path.trim().is_empty() {
                workspace_path.trim().to_string()
            } else if let Some(cid) = conversation_id {
                g.sessions
                    .iter()
                    .find(|s| s.conversation_id == cid)
                    .map(|s| s.workspace_path.clone())
                    .unwrap_or_default()
            } else {
                g.sessions
                    .first()
                    .map(|s| s.workspace_path.clone())
                    .unwrap_or_default()
            }
        };

        let dir_buf = if resolved_ws.is_empty() {
            std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
        } else {
            PathBuf::from(&resolved_ws)
        };
        if !dir_buf.is_dir() {
            return Err(format!("Workspace directory does not exist: {}", dir_buf.display()));
        }
        let clean_ws = dir_buf.to_string_lossy().to_string();
        let ws_name = dir_buf
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .filter(|n| !n.is_empty())
            .unwrap_or_else(|| clean_ws.clone());

        let (effective_perm, resume_cli_cid, ide_handoff_context) = {
            let g = self.inner.lock().unwrap();
            let target_sess = conversation_id.and_then(|cid| {
                g.sessions
                    .iter()
                    .find(|s| s.conversation_id == cid || s.cli_conversation_id.as_deref() == Some(cid))
            });
            let perm = target_sess
                .and_then(|s| s.permission_override.clone())
                .unwrap_or_else(|| g.settings.permission_mode.clone());

            // IMPORTANT: `agy.exe --conversation <id>` ONLY recognizes trajectories created by `agy.exe`,
            // NOT Antigravity Desktop/IDE conversation UUIDs (which fail with `not_found: trajectory not found`).
            // So we resume ONLY via `cli_conversation_id`; for an idle IDE session with no linked CLI session yet,
            // we launch a fresh workspace CLI session carrying concise context from the last IDE turn, then link it!
            let cli_cid = target_sess.and_then(|s| s.cli_conversation_id.clone());
            let handoff_ctx = if target_sess.is_some() && cli_cid.is_none() {
                target_sess.map(|s| {
                    let prev_q = s.last_user_input.as_deref().unwrap_or("").trim();
                    let prev_a = s
                        .latest_output
                        .as_deref()
                        .map(|o| truncate_chars(o.trim(), 700))
                        .unwrap_or_default();
                    if prev_q.is_empty() && prev_a.is_empty() {
                        String::new()
                    } else {
                        format!(
                            "[Context from preceding Antigravity IDE session in workspace `{}`:\nLast user request: {}\nLast assistant summary: {}]\n\n",
                            s.workspace_name,
                            truncate_chars(prev_q, 240),
                            prev_a
                        )
                    }
                })
            } else {
                None
            };
            (perm, cli_cid, handoff_ctx)
        };

        let ide_perm_live = detect_antigravity_permission_mode(Some(&clean_ws));
        let ide_is_turbo = ide_perm_live
            .as_deref()
            .is_some_and(|p| p.eq_ignore_ascii_case("turbo"));

        let agy_mode = mode.unwrap_or("auto");
        let skip_perms = effective_perm.eq_ignore_ascii_case("turbo")
            || (effective_perm.eq_ignore_ascii_case("follow_agy") && (ide_is_turbo || agy_mode == "auto"));

        let prompt_for_agy = match ide_handoff_context.as_deref().filter(|s| !s.is_empty()) {
            Some(ctx) => format!("{ctx}{final_prompt}"),
            None => final_prompt.clone(),
        };

        let mut child = spawn_headless_agy_turn(
            &agy_exe,
            &dir_buf,
            resume_cli_cid.as_deref(),
            &prompt_for_agy,
            agy_mode,
            effort,
            skip_perms,
        )?;
        let pid = child.id();
        let child_stdout = child.stdout.take();
        let child_stderr = child.stderr.take();
        let now = chrono::Utc::now().to_rfc3339();
        let summary_prompt = truncate_chars(&final_prompt, 240);

        let tracked_cid = {
            let mut g = self.inner.lock().unwrap();
            if let Some(cid) = conversation_id.map(str::trim).filter(|s| !s.is_empty()) {
                if let Some(sess) = g
                    .sessions
                    .iter_mut()
                    .find(|s| s.conversation_id == cid || s.cli_conversation_id.as_deref() == Some(cid))
                {
                    let canonical = sess.conversation_id.clone();
                    sess.status = "active".into();
                    sess.phase = "thinking".into();
                    sess.bg_running = true;
                    sess.stop_requested = false;
                    sess.last_user_input = Some(summary_prompt);
                    sess.latest_output = None;
                    sess.last_error = None;
                    sess.mid_process_note = Some("Warming up Antigravity CLI & tools…".into());
                    sess.current_focus = None;
                    if ide_perm_live.is_some() {
                        sess.detected_ide_permission = ide_perm_live.clone();
                    }
                    sess.plan_steps.clear();
                    sess.focus_groups.clear();
                    sess.steps.clear();
                    sess.diffs.clear();
                    sess.updated_at = now;
                    g.bg_pids.insert(canonical.clone(), pid);
                    canonical
                } else {
                    let pending_id = format!("pending-{}", uuid::Uuid::new_v4().simple());
                    g.bg_pids.insert(pending_id.clone(), pid);
                    g.sessions.insert(
                        0,
                        AgentSession {
                            conversation_id: pending_id.clone(),
                            agent: "antigravity".into(),
                            workspace_path: clean_ws.clone(),
                            workspace_name: ws_name,
                            git_branch: detect_git_branch_for_dir(&clean_ws),
                            model_name: None,
                            last_user_input: Some(summary_prompt),
                            status: "active".into(),
                            phase: "thinking".into(),
                            current_focus: None,
                            mid_process_note: Some("Warming up Antigravity CLI & tools…".into()),
                            latest_thinking: None,
                            latest_output: None,
                            plan_steps: Vec::new(),
                            focus_groups: Vec::new(),
                            transcript_path: None,
                            queued_messages: Vec::new(),
                            stop_requested: false,
                            bg_running: true,
                            cli_conversation_id: None,
                            last_error: None,
                            detected_ide_permission: ide_perm_live.clone(),
                            permission_override: None,
                            active_tool: None,
                            steps: Vec::new(),
                            diffs: Vec::new(),
                            subagents: Vec::new(),
                            process_chain: Vec::new(),
                            started_at: now.clone(),
                            updated_at: now,
                            commands_count: 0,
                            files_touched_count: 0,
                        },
                    );
                    pending_id
                }
            } else {
                let pending_id = format!("pending-{}", uuid::Uuid::new_v4().simple());
                g.bg_pids.insert(pending_id.clone(), pid);
                g.sessions.insert(
                    0,
                    AgentSession {
                        conversation_id: pending_id.clone(),
                        agent: "antigravity".into(),
                        workspace_path: clean_ws.clone(),
                        workspace_name: ws_name,
                        git_branch: detect_git_branch_for_dir(&clean_ws),
                        model_name: None,
                        last_user_input: Some(summary_prompt),
                        status: "active".into(),
                        phase: "thinking".into(),
                        current_focus: None,
                        mid_process_note: Some("Warming up Antigravity CLI & tools…".into()),
                        latest_thinking: None,
                        latest_output: None,
                        plan_steps: Vec::new(),
                        focus_groups: Vec::new(),
                        transcript_path: None,
                        queued_messages: Vec::new(),
                        stop_requested: false,
                        bg_running: true,
                        cli_conversation_id: None,
                        last_error: None,
                        detected_ide_permission: ide_perm_live.clone(),
                        permission_override: None,
                        active_tool: None,
                        steps: Vec::new(),
                        diffs: Vec::new(),
                        subagents: Vec::new(),
                        process_chain: Vec::new(),
                        started_at: now.clone(),
                        updated_at: now,
                        commands_count: 0,
                        files_touched_count: 0,
                    },
                );
                pending_id
            }
        };

        self.broadcast_snapshot(Some("step"));

        // Drain stderr on a dedicated lightweight thread so pipe never blocks
        let stderr_lines: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
        let stderr_buf_clone = stderr_lines.clone();
        let stderr_handle = std::thread::spawn(move || {
            if let Some(err_stream) = child_stderr {
                for line in BufReader::new(err_stream).lines().map_while(Result::ok) {
                    let trimmed = line.trim().to_string();
                    if trimmed.is_empty() {
                        continue;
                    }
                    let mut buf = stderr_buf_clone.lock().unwrap();
                    if buf.len() < 64 {
                        buf.push(trimmed);
                    }
                }
            }
        });

        // Stream NDJSON events from `agy.exe --output-format stream-json` live into session state!
        let reaper_core = self.clone();
        tokio::task::spawn_blocking(move || {
            let mut active_cid = tracked_cid;
            let mut streamed_text = String::new();
            let mut stream_succeeded = false;
            let mut stream_error: Option<String> = None;
            let mut last_broadcast = std::time::Instant::now();

            if let Some(out_stream) = child_stdout {
                for line in BufReader::new(out_stream).lines().map_while(Result::ok) {
                    let trimmed = line.trim();
                    if trimmed.is_empty() || !trimmed.starts_with('{') {
                        continue;
                    }
                    let Ok(ev) = serde_json::from_str::<Value>(trimmed) else {
                        continue;
                    };
                    let ev_kind = ev.get("event").and_then(|v| v.as_str()).unwrap_or("");
                    let mut should_broadcast = false;

                    match ev_kind {
                        "init" => {
                            let cli_cid = ev
                                .get("conversation_id")
                                .and_then(|v| v.as_str())
                                .map(str::trim)
                                .filter(|s| !s.is_empty())
                                .map(str::to_string);
                            let mut g = reaper_core.inner.lock().unwrap();
                            let mut promoted_pair: Option<(String, String)> = None;
                            if let Some(sess) = g
                                .sessions
                                .iter_mut()
                                .find(|s| s.conversation_id == active_cid)
                            {
                                if let Some(ref cid_val) = cli_cid {
                                    sess.cli_conversation_id = Some(cid_val.clone());
                                    if sess.conversation_id.starts_with("pending-") {
                                        let old = sess.conversation_id.clone();
                                        sess.conversation_id = cid_val.clone();
                                        active_cid = cid_val.clone();
                                        promoted_pair = Some((old, cid_val.clone()));
                                    }
                                }
                                sess.mid_process_note =
                                    Some("Connected — waiting for agent response…".into());
                                sess.updated_at = chrono::Utc::now().to_rfc3339();
                                should_broadcast = true;
                            }
                            if let Some((old, new_id)) = promoted_pair {
                                if let Some(p) = g.bg_pids.remove(&old) {
                                    g.bg_pids.insert(new_id, p);
                                }
                            }
                        }
                        "step_update" => {
                            if let Some(su) = ev.get("step_update") {
                                let step_type = su
                                    .get("step_type")
                                    .and_then(|v| v.as_str())
                                    .unwrap_or("");
                                let delta = su
                                    .get("text_delta")
                                    .or_else(|| su.get("delta"))
                                    .and_then(|v| v.as_str())
                                    .unwrap_or("");
                                let mut g = reaper_core.inner.lock().unwrap();
                                if let Some(sess) = g
                                    .sessions
                                    .iter_mut()
                                    .find(|s| s.conversation_id == active_cid)
                                {
                                    if !delta.is_empty() {
                                        streamed_text.push_str(delta);
                                        sess.latest_output =
                                            Some(truncate_chars(streamed_text.trim(), 8_500));
                                        sess.phase = "working".into();
                                        sess.mid_process_note = None;
                                        sess.updated_at = chrono::Utc::now().to_rfc3339();
                                        if last_broadcast.elapsed().as_millis() >= 120 {
                                            should_broadcast = true;
                                        }
                                    } else if step_type == "user_input" {
                                        sess.mid_process_note = Some("Agent thinking…".into());
                                        sess.updated_at = chrono::Utc::now().to_rfc3339();
                                        should_broadcast = true;
                                    }
                                }
                            }
                        }
                        "result" => {
                            if let Some(res) = ev.get("result") {
                                let status_str = res
                                    .get("status")
                                    .and_then(|v| v.as_str())
                                    .unwrap_or("");
                                let resp_str = res
                                    .get("response")
                                    .and_then(|v| v.as_str())
                                    .map(str::trim)
                                    .filter(|s| !s.is_empty());
                                let err_str = res
                                    .get("error")
                                    .and_then(|v| v.as_str())
                                    .map(str::trim)
                                    .filter(|s| !s.is_empty());

                                if status_str.eq_ignore_ascii_case("SUCCESS") {
                                    stream_succeeded = true;
                                }
                                if let Some(e) = err_str {
                                    stream_error = Some(e.to_string());
                                }
                                let mut g = reaper_core.inner.lock().unwrap();
                                if let Some(sess) = g
                                    .sessions
                                    .iter_mut()
                                    .find(|s| s.conversation_id == active_cid)
                                {
                                    if let Some(r) = resp_str {
                                        sess.latest_output = Some(truncate_chars(r, 8_500));
                                    }
                                    if let Some(e) = err_str {
                                        sess.last_error = Some(truncate_chars(e, 500));
                                        if e.to_ascii_lowercase().contains("trajectory not found") {
                                            sess.cli_conversation_id = None;
                                        }
                                    }
                                    sess.updated_at = chrono::Utc::now().to_rfc3339();
                                    should_broadcast = true;
                                }
                            }
                        }
                        _ => {}
                    }

                    if should_broadcast {
                        last_broadcast = std::time::Instant::now();
                        reaper_core.broadcast_snapshot(None);
                    }
                }
            }

            let exit_ok = child.wait().map(|s| s.success()).unwrap_or(false);
            let _ = stderr_handle.join();

            let captured_stderr_err = {
                let buf = stderr_lines.lock().unwrap();
                buf.iter()
                    .rev()
                    .find(|l| !l.to_ascii_lowercase().starts_with("warning:"))
                    .or_else(|| buf.last())
                    .cloned()
            };

            let final_ok = stream_succeeded || (exit_ok && stream_error.is_none());
            let now_done = chrono::Utc::now().to_rfc3339();
            let mut changed = false;
            {
                let mut g = reaper_core.inner.lock().unwrap();
                let matching_cid = g
                    .bg_pids
                    .iter()
                    .find(|(_, &p)| p == pid)
                    .map(|(k, _)| k.clone())
                    .unwrap_or_else(|| active_cid.clone());
                g.bg_pids.remove(&matching_cid);
                if let Some(sess) = g
                    .sessions
                    .iter_mut()
                    .find(|s| s.conversation_id == matching_cid || s.conversation_id == active_cid)
                {
                    sess.bg_running = false;
                    sess.active_tool = None;
                    sess.mid_process_note = None;
                    sess.updated_at = now_done.clone();
                    for st in &mut sess.steps {
                        if st.status == "running" {
                            st.status = if final_ok { "done" } else { "error" }.into();
                        }
                    }
                    for fg in &mut sess.focus_groups {
                        if fg.ended_at.is_none() {
                            fg.ended_at = Some(now_done.clone());
                        }
                        for st in &mut fg.steps {
                            if st.status == "running" {
                                st.status = if final_ok { "done" } else { "error" }.into();
                            }
                        }
                    }
                    if final_ok {
                        sess.status = "completed".into();
                        sess.phase = "done".into();
                        sess.last_error = None;
                    } else if sess.status != "completed" {
                        sess.status = "error".into();
                        sess.phase = "error".into();
                        if sess.last_error.is_none() {
                            let err_msg = stream_error
                                .or(captured_stderr_err)
                                .unwrap_or_else(|| "Antigravity CLI exited with an error.".into());
                            if err_msg.to_ascii_lowercase().contains("trajectory not found") {
                                sess.cli_conversation_id = None;
                            }
                            sess.last_error = Some(truncate_chars(&err_msg, 500));
                        }
                    }
                    changed = true;
                }
            }
            if changed {
                reaper_core.broadcast_snapshot(Some(if final_ok { "ready" } else { "denied" }));
            }
        });

        Ok(json!({
            "ok": true,
            "delivery": "headless_agy",
            "pid": pid
        }))
    }

    /// Halts an active session via hook termination + pending approval denial + owned headless PID kill.
    pub fn stop_agent_session(&self, conversation_id: &str) -> Result<(), String> {
        let pid_to_kill: Option<u32>;
        let mut approval_ids_to_deny: Vec<String> = Vec::new();

        {
            let mut g = self.inner.lock().unwrap();
            pid_to_kill = g.bg_pids.remove(conversation_id);

            for p in &g.pending_approvals {
                if p.conversation_id == conversation_id {
                    approval_ids_to_deny.push(p.id.clone());
                }
            }

            if let Some(sess) = g
                .sessions
                .iter_mut()
                .find(|s| s.conversation_id == conversation_id)
            {
                sess.stop_requested = true;
                sess.queued_messages.clear();
                sess.mid_process_note = None;
                sess.active_tool = None;
                if pid_to_kill.is_some() {
                    sess.bg_running = false;
                    sess.status = "completed".into();
                    sess.phase = "done".into();
                    for st in &mut sess.steps {
                        if st.status == "running" {
                            st.status = "done".into();
                        }
                    }
                }
            } else {
                return Err("Session not found".to_string());
            }
        }

        for aid in approval_ids_to_deny {
            let _ = self.resolve_approval(
                &aid,
                "deny",
                None,
                None,
                Some("Session stopped by user"),
            );
        }

        if let Some(pid) = pid_to_kill {
            let _ = kill_owned_child_tree(pid);
        }

        self.broadcast_snapshot(Some("denied"));
        Ok(())
    }

    pub fn set_permission_mode(
        &self,
        global_mode: Option<&str>,
        conversation_id: Option<&str>,
        session_override: Option<&str>,
    ) -> Result<(), String> {
        let valid = ["follow_agy", "turbo", "smart_auto", "request_review"];
        {
            let mut g = self.inner.lock().unwrap();
            if let Some(gm) = global_mode.map(str::trim).filter(|s| !s.is_empty()) {
                if !valid.contains(&gm) {
                    return Err(format!("Unsupported permission mode: {gm}"));
                }
                g.settings.permission_mode = gm.to_string();
            }
            if let Some(cid) = conversation_id.map(str::trim).filter(|s| !s.is_empty()) {
                if let Some(sess) = g.sessions.iter_mut().find(|s| s.conversation_id == cid) {
                    match session_override.map(str::trim) {
                        Some("") | None => sess.permission_override = None,
                        Some(ov) if valid.contains(&ov) => {
                            sess.permission_override = Some(ov.to_string())
                        }
                        Some(other) => return Err(format!("Unsupported override: {other}")),
                    }
                }
            }
        }
        self.persist();
        self.broadcast_snapshot(None);
        Ok(())
    }

    /// Reverts the most recent undoable edit on `file_path` in a session.
    pub fn revert_file_diff(
        &self,
        conversation_id: &str,
        file_path: &str,
    ) -> Result<String, String> {
        let (undo_target, undo_replacement) = {
            let g = self.inner.lock().unwrap();
            let sess = g
                .sessions
                .iter()
                .find(|s| s.conversation_id == conversation_id)
                .ok_or_else(|| "Session not found".to_string())?;
            let diff = sess
                .diffs
                .iter()
                .find(|d| d.file_path == file_path && !d.reverted)
                .ok_or_else(|| "No revertible diff found for this file".to_string())?;
            let ut = diff
                .undo_target
                .clone()
                .ok_or_else(|| "Undo snapshot unavailable for this file".to_string())?;
            let ur = diff
                .undo_replacement
                .clone()
                .ok_or_else(|| "Undo replacement unavailable for this file".to_string())?;
            (ut, ur)
        };

        let path = Path::new(file_path);
        if !path.is_file() {
            return Err("File no longer exists on disk".to_string());
        }
        let current = fs::read_to_string(path).map_err(|e| format!("Failed reading file: {e}"))?;
        let restored = if !undo_replacement.is_empty() && current.contains(&undo_replacement) {
            current.replacen(&undo_replacement, &undo_target, 1)
        } else if current == undo_replacement {
            undo_target
        } else {
            return Err(
                "File has changed since this edit; open in Antigravity IDE to review manually"
                    .to_string(),
            );
        };

        fs::write(path, restored).map_err(|e| format!("Failed writing reverted file: {e}"))?;

        {
            let mut g = self.inner.lock().unwrap();
            if let Some(sess) = g
                .sessions
                .iter_mut()
                .find(|s| s.conversation_id == conversation_id)
            {
                if let Some(diff) = sess
                    .diffs
                    .iter_mut()
                    .find(|d| d.file_path == file_path && !d.reverted)
                {
                    diff.reverted = true;
                }
            }
        }

        self.broadcast_snapshot(Some("step"));
        let base = path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| file_path.to_string());
        Ok(format!("Reverted edit in {base}"))
    }

    pub fn generate_devlog_markdown(&self) -> String {
        let g = self.inner.lock().unwrap();
        let date = chrono::Local::now().format("%Y-%m-%d %H:%M");
        let mut md = format!(
            "# NOVA Personal Dev & Focus Recap ({date})\n\n\
             ## Summary Metrics\n\
             - **Agent Sessions Tracked:** {}\n\
             - **Commands Inspected:** {} (Allowed: {}, Auto-Passed: {}, Denied: {})\n\
             - **Files Edited:** {} (`+{}` / `-{}` lines)\n\
             - **Focus Time (Novadoro):** {} mins ({} blocks today)\n\
             - **Voice Dictations:** {} ({} words)\n\n",
            g.analytics.total_sessions,
            g.analytics.total_commands_inspected,
            g.analytics.approvals_allowed,
            g.analytics.approvals_auto_passed,
            g.analytics.approvals_denied,
            g.analytics.files_edited,
            g.analytics.lines_added,
            g.analytics.lines_removed,
            g.analytics.focus_minutes,
            g.focus.completed_blocks_today,
            g.analytics.dictations_count,
            g.analytics.dictated_words,
        );

        if !g.sessions.is_empty() {
            md.push_str("## Recent Workspaces\n");
            for s in g.sessions.iter().take(8) {
                md.push_str(&format!(
                    "- **{}** (`{}`) — {} commands, {} file edits, status: `{}`\n",
                    s.workspace_name,
                    s.git_branch.as_deref().unwrap_or("main"),
                    s.commands_count,
                    s.files_touched_count,
                    s.status
                ));
            }
            md.push('\n');
        }

        if !g.voice_notes.is_empty() {
            md.push_str("## Voice & Meeting Notes\n");
            for n in g.voice_notes.iter().take(5) {
                md.push_str(&format!("### {}\n{}\n", n.title, n.summary));
                for item in &n.action_items {
                    md.push_str(&format!(
                        "- [{}] {}\n",
                        if item.done { "x" } else { " " },
                        item.text
                    ));
                }
                md.push('\n');
            }
        }

        md
    }
}
