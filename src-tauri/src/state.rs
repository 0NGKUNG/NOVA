use crate::agy_hooks::{inspect_antigravity_hooks, nova_data_dir};
use crate::ai_services::{build_mobile_pairing_info, secret_presence_map, send_telegram_approval_alert};
use crate::agents::AgentProvider;
use crate::models::{
    AccountQuotaInfo, AgentSession, AnalyticsCounters, ApprovalRule, ChatMessage, ChatPersona,
    ChatThread, ClipboardEntry, FileDiffPreview, FocusGroup, FocusState, HookRelayResponse,
    NormalizedHookEnvelope, NovaSettings, NovaSnapshot, PendingApproval, PendingQuestion,
    PlanStepItem, QuestionExchange, QuestionItem, RealtimeQuotaState, SessionArtifact,
    SessionStep, SessionTurn, SubagentNode, TechTerm, VoiceNote, VoiceSnippet,
};
use crate::risk::{assess_tool_risk, build_file_diff_preview};
use crate::system_tools::{
    annotate_altgr_conflicts, detect_antigravity_permission_mode, discover_recent_workspaces,
    kill_owned_child_tree, local_lan_ipv4, read_clipboard_text, resolve_agy_cli_path,
    save_image_data_url_to_disk,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use sysinfo::System;
use tokio::sync::{broadcast, oneshot};

pub const CORE_PORT: u16 = 47920;

#[derive(Debug, Clone)]
pub struct AccountUsageHistory {
    pub minute_requests: std::collections::VecDeque<std::time::Instant>,
    pub daily_request_count: u32,
    pub daily_reset_epoch_day: u64,
    pub total_tokens_today: u64,
    pub last_429: Option<std::time::Instant>,
    pub last_probe_status: Option<String>,
}

impl Default for AccountUsageHistory {
    fn default() -> Self {
        Self {
            minute_requests: std::collections::VecDeque::new(),
            daily_request_count: 0,
            daily_reset_epoch_day: chrono::Utc::now().timestamp() as u64 / 86400,
            total_tokens_today: 0,
            last_429: None,
            last_probe_status: None,
        }
    }
}

#[derive(Debug, Clone, Default)]
pub struct QuotaTracker {
    pub main: AccountUsageHistory,
    pub second: AccountUsageHistory,
}

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

pub struct WarmAgyWorker {
    pub pid: u32,
    pub stdin: Arc<Mutex<std::process::ChildStdin>>,
    pub mode: String,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub workspace_path: String,
    pub skip_permissions: bool,
    pub turn_active: bool,
    pub last_used_at: std::time::Instant,
}

#[derive(Debug, Clone)]
pub struct EmbedTicketEntry {
    pub file_path: String,
    pub conversation_id: Option<String>,
    pub embed_id: String,
    pub inline: bool,
    pub expires_at: std::time::Instant,
}

pub struct InnerState {
    pub settings: NovaSettings,
    pub sessions: Vec<AgentSession>,
    pub pending_approvals: Vec<PendingApproval>,
    pub pending_questions: Vec<PendingQuestion>,
    pub approval_waiters: HashMap<String, oneshot::Sender<HookRelayResponse>>,
    pub question_waiters: HashMap<String, oneshot::Sender<HookRelayResponse>>,
    pub pending_tool_diffs: HashMap<String, FileDiffPreview>,
    pub bg_pids: HashMap<String, u32>,
    pub warm_workers: HashMap<String, WarmAgyWorker>,
    pub embed_tickets: HashMap<String, EmbedTicketEntry>,
    pub approval_rules: Vec<ApprovalRule>,
    pub threads: Vec<ChatThread>,
    pub personas: Vec<ChatPersona>,
    pub clipboard_history: Vec<ClipboardEntry>,
    pub tech_dictionary: Vec<TechTerm>,
    pub voice_snippets: Vec<VoiceSnippet>,
    pub voice_notes: Vec<VoiceNote>,
    pub focus: FocusState,
    pub analytics: AnalyticsCounters,
    pub quota_tracker: QuotaTracker,
    pub ipc_token: String,
    pub pairing_token: String,
    pub lan_ip: String,
}

pub type UiLivenessFn = Arc<dyn Fn() -> oneshot::Receiver<()> + Send + Sync>;

#[derive(Clone)]
pub struct AppCore {
    pub inner: Arc<Mutex<InnerState>>,
    pub sys: Arc<Mutex<System>>,
    pub events_tx: broadcast::Sender<Value>,
    pub ui_liveness: Arc<Mutex<Option<UiLivenessFn>>>,
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

fn strip_nova_prompt_wrappers(s: &str) -> String {
    let mut cur = s.trim_matches(['\n', '\r']);

    // 1. Strip structured `<NOVA_HANDOFF_CONTEXT>...</NOVA_HANDOFF_CONTEXT>` wrapper
    let trimmed_start = cur.trim_start();
    if let (Some(start), Some(end)) = (
        trimmed_start.find("<NOVA_HANDOFF_CONTEXT>"),
        trimmed_start.find("</NOVA_HANDOFF_CONTEXT>"),
    ) {
        if start == 0 && end >= start {
            cur = trimmed_start[end + "</NOVA_HANDOFF_CONTEXT>".len()..]
                .trim_start_matches([' ', '\t'])
                .trim_matches(['\n', '\r']);
        }
    }

    // 2. Strip legacy `[Context from preceding Antigravity IDE session ...]\n\n` prefix
    let trimmed_legacy = cur.trim_start();
    if trimmed_legacy.starts_with("[Context from preceding Antigravity IDE session") {
        let summary_anchor = trimmed_legacy.find("Last assistant summary:").unwrap_or(0);
        let tail = &trimmed_legacy[summary_anchor..];
        if let Some(rel_close) = tail.find("]\n\n") {
            let after = tail[rel_close + 3..].trim_matches(['\n', '\r']);
            if !after.trim().is_empty() {
                cur = after;
            }
        } else if let Some(rel_close) = tail.find("]\n") {
            let after = tail[rel_close + 2..].trim_matches(['\n', '\r']);
            if !after.trim().is_empty() {
                cur = after;
            }
        }
    }

    // 3. Clean NOVA's internal screenshot/image tool instruction suffix if present
    let mut owned = cur.to_string();
    if let Some(att_idx) = owned.rfind("\n\n[Attached Screenshot: `") {
        let suffix = &owned[att_idx + "\n\n[Attached Screenshot: `".len()..];
        if let Some((path_part, rest)) = suffix.split_once('`') {
            if rest.contains("inspect this image file") && rest.trim_end().ends_with(']') {
                let base = Path::new(path_part)
                    .file_name()
                    .map(|n| n.to_string_lossy().to_string())
                    .filter(|n| !n.is_empty())
                    .unwrap_or_else(|| "snip.png".to_string());
                owned.truncate(att_idx);
                owned.push_str(&format!("\n\n📎 Attached screenshot: `{base}`"));
            }
        }
    } else if let Some(multi_idx) = owned.rfind("\n\n[Attached Images — inspect each image file with read_file:\n") {
        let suffix = &owned[multi_idx..];
        if suffix.trim_end().ends_with(']') {
            let names: Vec<String> = suffix
                .lines()
                .filter_map(|l| {
                    let (_, after) = l.split_once('`')?;
                    let (p, _) = after.split_once('`')?;
                    Path::new(p)
                        .file_name()
                        .map(|n| format!("`{}`", n.to_string_lossy()))
                })
                .collect();
            if !names.is_empty() {
                owned.truncate(multi_idx);
                owned.push_str(&format!("\n\n📎 Attached images: {}", names.join(", ")));
            }
        }
    } else if owned.starts_with("Inspect the attached screenshot at `")
        && owned.ends_with("using read_file and fix any visual or UI issue you find.")
    {
        if let Some(rest) = owned.strip_prefix("Inspect the attached screenshot at `") {
            if let Some((path_part, _)) = rest.split_once('`') {
                let base = Path::new(path_part)
                    .file_name()
                    .map(|n| n.to_string_lossy().to_string())
                    .filter(|n| !n.is_empty())
                    .unwrap_or_else(|| "snip.png".to_string());
                owned = format!(
                    "📎 Inspect attached screenshot (`{base}`) and fix any visual or UI issue"
                );
            }
        }
    } else if owned.starts_with("Inspect the attached images using read_file and address what they show:\n") {
        let names: Vec<String> = owned
            .lines()
            .filter_map(|l| {
                let (_, after) = l.split_once('`')?;
                let (p, _) = after.split_once('`')?;
                Path::new(p)
                    .file_name()
                    .map(|n| format!("`{}`", n.to_string_lossy()))
            })
            .collect();
        if !names.is_empty() {
            owned = format!("📎 Inspect attached images ({})", names.join(", "));
        }
    }

    // 4. Fallback for pre-truncated legacy handoff strings with no trailing user prompt
    if owned.starts_with("[Context from preceding Antigravity IDE session") {
        owned = owned
            .trim_start_matches('[')
            .trim_end_matches(']')
            .replace("\nLast user request:", "\n**Last user request:**")
            .replace(" Last user request:", "\n**Last user request:**")
            .replace("\nLast assistant summary:", "\n**Last assistant summary:**")
            .replace(" Last assistant summary:", "\n**Last assistant summary:**");
    }

    owned
}

/// Strips `<USER_REQUEST>`, `<ADDITIONAL_METADATA>`, `<USER_SETTINGS_CHANGE>`, `<SYSTEM_MESSAGE>`,
/// and NOVA handoff wrappers while preserving multi-line formatting and full prompt content.
fn clean_user_prompt(raw: &str) -> Option<String> {
    let normalized_crlf;
    let src = if raw.contains('\r') {
        normalized_crlf = raw.replace("\r\n", "\n").replace('\r', "\n");
        normalized_crlf.as_str()
    } else {
        raw
    };

    let has_image = src.contains("uploaded") && src.contains("image(s):");
    let extracted = if let (Some(start), Some(end)) =
        (src.find("<USER_REQUEST>"), src.find("</USER_REQUEST>"))
    {
        let inner_start = start + "<USER_REQUEST>".len();
        if end >= inner_start {
            &src[inner_start..end]
        } else {
            src
        }
    } else {
        let cuts = [
            src.find("<ADDITIONAL_METADATA>"),
            src.find("<USER_SETTINGS_CHANGE>"),
            src.find("<SYSTEM_MESSAGE>"),
            src.find("\n\nThe following is a <SYSTEM_MESSAGE>"),
        ];
        let cut = cuts.into_iter().flatten().min().unwrap_or(src.len());
        &src[..cut]
    };

    let stripped = strip_nova_prompt_wrappers(extracted);

    let mut lines_out: Vec<&str> = Vec::new();
    for line in stripped.lines() {
        let rtrimmed = line.trim_end();
        if rtrimmed.trim().is_empty() {
            if !lines_out.is_empty() {
                lines_out.push("");
            }
        } else {
            lines_out.push(rtrimmed);
        }
    }
    while lines_out.last().is_some_and(|l| l.is_empty()) {
        lines_out.pop();
    }
    let formatted = lines_out.join("\n");

    if formatted.is_empty() {
        if has_image {
            return Some("📎 Screenshot / media attached".to_string());
        }
        return None;
    }
    Some(truncate_chars(&formatted, 16_000))
}

fn humanize_model_name(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed.eq_ignore_ascii_case("auto") {
        return None;
    }
    if trimmed.contains(' ') || trimmed.contains('(') {
        return Some(trimmed.to_string());
    }
    let lower = trimmed.to_ascii_lowercase();
    let (base, effort_label) = if let Some(b) = lower.strip_suffix("-xhigh") {
        (b, Some("XHigh"))
    } else if let Some(b) = lower.strip_suffix("-high") {
        (b, Some("High"))
    } else if let Some(b) = lower.strip_suffix("-medium") {
        (b, Some("Med"))
    } else if let Some(b) = lower.strip_suffix("-low") {
        (b, Some("Low"))
    } else {
        (lower.as_str(), None)
    };

    let pretty_base = match base {
        "gemini-3.8-flash" => "Gemini 3.8 Flash".to_string(),
        "gemini-4-carbon" => "Gemini 4 Carbon".to_string(),
        "gemini-4-hydrogen" => "Gemini 4 Hydrogen".to_string(),
        "gemini-4-neon" => "Gemini 4 Neon".to_string(),
        "gemini-4-argon" => "Gemini 4 Argon".to_string(),
        "gemini-pro-orchestrator" => "Gemini Pro Orchestrator".to_string(),
        "gemini-pro-orchestrator-neon" => "Gemini Pro Orchestrator (Neon)".to_string(),
        "gemini-pro-orchestrator-argon" => "Gemini Pro Orchestrator (Argon)".to_string(),
        "claude-sonnet-5-5" => "Claude Sonnet 5.5".to_string(),
        "claude-opus-5-5" => "Claude Opus 5.5".to_string(),
        "gpt-oss-120b" => "GPT-OSS 120B".to_string(),
        other => other
            .split('-')
            .filter(|s| !s.is_empty())
            .map(|part| {
                let mut chars = part.chars();
                match chars.next() {
                    Some(first) => format!("{}{}", first.to_ascii_uppercase(), chars.as_str()),
                    None => String::new(),
                }
            })
            .collect::<Vec<_>>()
            .join(" "),
    };

    Some(match effort_label {
        Some(eff) => format!("{pretty_base} ({eff})"),
        None => pretty_base,
    })
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

fn extract_question_items(args: &Value) -> Option<Vec<QuestionItem>> {
    let raw_questions = args.get("questions")?;
    let unwrapped = unwrap_protojson_arg(raw_questions);
    let arr = unwrapped.as_array()?;
    let mut out = Vec::with_capacity(arr.len());
    for item in arr.iter().take(12) {
        let question = item
            .get("question")
            .or_else(|| item.get("header"))
            .and_then(|v| v.as_str())
            .map(str::trim)
            .unwrap_or_default();
        if question.is_empty() {
            continue;
        }
        let options: Vec<String> = item
            .get("options")
            .map(unwrap_protojson_arg)
            .and_then(|v| v.as_array().cloned())
            .unwrap_or_default()
            .into_iter()
            .filter_map(|opt| {
                if let Some(s) = opt.as_str() {
                    let t = s.trim();
                    (!t.is_empty()).then(|| t.to_string())
                } else if let Some(lbl) = opt.get("label").and_then(|v| v.as_str()) {
                    let t = lbl.trim();
                    (!t.is_empty()).then(|| t.to_string())
                } else {
                    None
                }
            })
            .take(12)
            .collect();
        let is_multi_select = item
            .get("is_multi_select")
            .or_else(|| item.get("isMultiSelect"))
            .or_else(|| item.get("multiSelect"))
            .map(unwrap_protojson_arg)
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        out.push(QuestionItem {
            question: truncate_chars(question, 400),
            options,
            is_multi_select,
        });
    }
    (!out.is_empty()).then_some(out)
}

fn parse_question_result_answers(content: &str, question_count: usize) -> (Vec<String>, bool) {
    let mut answers = vec![String::new(); question_count.max(1)];
    let mut found_numbered = false;
    let mut skipped = false;

    for raw_line in content.lines() {
        let line = raw_line.trim();
        if line.is_empty()
            || line.starts_with("Created At:")
            || line.starts_with("Completed At:")
        {
            continue;
        }
        let lower = line.to_ascii_lowercase();
        if lower.contains("user skipped")
            || lower.contains("skipped the question")
            || lower == "skipped"
        {
            skipped = true;
        }
        if let Some(rest) = line.strip_prefix('A') {
            if let Some((num_part, ans_part)) = rest.split_once(':') {
                if let Ok(idx1) = num_part.trim().parse::<usize>() {
                    if idx1 >= 1 && idx1 <= answers.len() {
                        answers[idx1 - 1] = ans_part.trim().to_string();
                        found_numbered = true;
                    }
                }
            }
        }
    }

    if !found_numbered && !skipped {
        // Check if denied-hook reason carried embedded `A1:` lines or plain fallback
        if content.to_ascii_lowercase().contains("skipped") {
            skipped = true;
        }
    }

    (answers, skipped)
}

fn percent_decode_path(raw: &str) -> String {
    let bytes = raw.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let h1 = (bytes[i + 1] as char).to_digit(16);
            let h2 = (bytes[i + 2] as char).to_digit(16);
            if let (Some(d1), Some(d2)) = (h1, h2) {
                out.push(((d1 << 4) | d2) as u8);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).to_string()
}

pub fn normalize_embed_file_path(raw: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    let without_scheme = if let Some(rest) = trimmed.strip_prefix("file://") {
        rest
    } else {
        trimmed
    };
    let before_frag = without_scheme
        .split('#')
        .next()
        .unwrap_or(without_scheme)
        .split('?')
        .next()
        .unwrap_or(without_scheme);
    let decoded = percent_decode_path(before_frag);
    let d_bytes = decoded.as_bytes();
    if d_bytes.len() >= 3 && d_bytes[0] == b'/' && d_bytes[1].is_ascii_alphabetic() && d_bytes[2] == b':' {
        decoded[1..].to_string()
    } else if !decoded.starts_with('/') && !(d_bytes.len() >= 2 && d_bytes[0].is_ascii_alphabetic() && d_bytes[1] == b':') && trimmed.starts_with("file://") {
        format!("/{decoded}")
    } else {
        decoded
    }
}

fn find_ascii_ci(haystack: &str, needle_lower: &str) -> Option<usize> {
    let nlen = needle_lower.len();
    if nlen == 0 || haystack.len() < nlen {
        return None;
    }
    let hbytes = haystack.as_bytes();
    let nbytes = needle_lower.as_bytes();
    (0..=hbytes.len() - nlen).find(|&i| {
        hbytes[i..i + nlen]
            .iter()
            .zip(nbytes.iter())
            .all(|(a, b)| a.to_ascii_lowercase() == *b)
    })
}

fn rfind_ascii_ci(haystack: &str, needle_lower: &str) -> Option<usize> {
    let nlen = needle_lower.len();
    if nlen == 0 || haystack.len() < nlen {
        return None;
    }
    let hbytes = haystack.as_bytes();
    let nbytes = needle_lower.as_bytes();
    (0..=hbytes.len() - nlen).rev().find(|&i| {
        hbytes[i..i + nlen]
            .iter()
            .zip(nbytes.iter())
            .all(|(a, b)| a.to_ascii_lowercase() == *b)
    })
}

pub fn inject_nova_embed_runtime(raw_html: &str, embed_id: &str, inline: bool) -> String {
    let bg_default = if inline { "transparent" } else { "var(--background)" };
    let theme_style = format!(
        r#"<style id="nova-agent-embed-vars">
:root {{
  color-scheme: dark;
  --background: #0d0e12;
  --content: #111217;
  --card: #16181f;
  --sidebar: #111216;
  --card-border: rgba(255, 255, 255, 0.10);
  --border: rgba(255, 255, 255, 0.12);
  --foreground: #eceef2;
  --muted-foreground: #9ca3af;
  --placeholder: #6b7280;
  --code-foreground: #e2e8f0;
  --primary: #3b82f6;
  --primary-foreground: #ffffff;
  --secondary: rgba(255, 255, 255, 0.08);
  --secondary-foreground: #f4f4f5;
  --accent: #8b5cf6;
  --link: #60a5fa;
  --success: #22c55e;
  --warning: #f59e0b;
  --error: #ef4444;
  --chart-1: #60a5fa;
  --chart-2: #a78bfa;
  --chart-3: #34d399;
  --chart-4: #fbbf24;
  --chart-5: #f472b6;
  --chart-6: #38bdf8;
}}
html {{
  margin: 0;
  padding: 0;
  height: auto !important;
  min-height: 0 !important;
  background: {bg_default};
}}
body {{
  margin: 0;
  padding: 0;
  display: flow-root;
  height: auto !important;
  min-height: 0 !important;
  background: {bg_default};
  color: var(--foreground);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, system-ui, sans-serif;
  font-size: 14px;
  line-height: 1.5;
}}
</style>"#
    );

    let embed_id_json = serde_json::to_string(embed_id).unwrap_or_else(|_| "\"nova-embed\"".to_string());
    let bridge_script = format!(
        r#"<script id="nova-agent-embed-bridge">
(function() {{
  var EMBED_ID = {embed_id_json};
  var lastHeight = 0;
  var rafId = 0;

  function measureContentHeight() {{
    var body = document.body;
    if (!body) return 0;
    var bodyRect = body.getBoundingClientRect();
    var h = Math.max(bodyRect.height, body.offsetHeight);
    var kids = body.children;
    for (var i = 0; i < kids.length; i++) {{
      var el = kids[i];
      if (el.id === "nova-agent-embed-bridge") continue;
      var r = el.getBoundingClientRect();
      var span = r.bottom - bodyRect.top;
      if (span > h) h = span;
    }}
    return Math.ceil(h);
  }}

  function postSize() {{
    rafId = 0;
    var h = measureContentHeight();
    if (h > 0 && Math.abs(h - lastHeight) >= 1) {{
      lastHeight = h;
      try {{
        window.parent.postMessage({{ type: "nova-agent-embed-resize", embedId: EMBED_ID, height: h }}, "*");
      }} catch (_e) {{}}
    }}
  }}

  function scheduleMeasure() {{
    if (!rafId) {{
      rafId = window.requestAnimationFrame(postSize);
    }}
  }}

  if (typeof ResizeObserver !== "undefined") {{
    var ro = new ResizeObserver(scheduleMeasure);
    if (document.body) ro.observe(document.body);
    window.addEventListener("DOMContentLoaded", function() {{
      if (document.body) ro.observe(document.body);
      scheduleMeasure();
    }});
  }}

  if (typeof MutationObserver !== "undefined") {{
    var startMo = function() {{
      if (!document.body) return;
      var mo = new MutationObserver(scheduleMeasure);
      mo.observe(document.body, {{ childList: true, subtree: true, attributes: true }});
    }};
    if (document.body) startMo();
    else window.addEventListener("DOMContentLoaded", startMo);
  }}

  window.addEventListener("load", scheduleMeasure);
  window.addEventListener("resize", scheduleMeasure);
  document.addEventListener("click", function() {{
    scheduleMeasure();
    setTimeout(scheduleMeasure, 50);
  }}, true);
  document.addEventListener("input", scheduleMeasure, true);
  document.addEventListener("change", scheduleMeasure, true);

  [30, 100, 260, 600, 1200].forEach(function(ms) {{
    setTimeout(scheduleMeasure, ms);
  }});
  scheduleMeasure();
}})();
</script>"#
    );

    let with_style = if let Some(head_pos) = find_ascii_ci(raw_html, "<head") {
        if let Some(rel_gt) = raw_html[head_pos..].find('>') {
            let insert_at = head_pos + rel_gt + 1;
            format!("{}\n{}{}", &raw_html[..insert_at], theme_style, &raw_html[insert_at..])
        } else {
            format!("{theme_style}\n{raw_html}")
        }
    } else {
        format!("{theme_style}\n{raw_html}")
    };

    if let Some(body_close) = rfind_ascii_ci(&with_style, "</body") {
        format!(
            "{}{}\n{}",
            &with_style[..body_close],
            bridge_script,
            &with_style[body_close..]
        )
    } else {
        format!("{with_style}\n{bridge_script}")
    }
}

fn extract_artifact_metadata(
    tool_name: &str,
    args: &Value,
    target_file: Option<&str>,
    timestamp: &str,
) -> Option<SessionArtifact> {
    if !matches!(
        tool_name,
        "write_file" | "edit_file" | "write_to_file" | "replace_file_content" | "Write" | "Edit"
    ) {
        return None;
    }
    let meta_raw = args
        .get("ArtifactMetadata")
        .or_else(|| args.get("artifactMetadata"))?;
    let meta = unwrap_protojson_arg(meta_raw);
    if !meta.is_object() {
        return None;
    }

    let fp = target_file
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .or_else(|| arg_string(args, &["Path", "TargetFile", "file_path"]))?;
    let file_name = Path::new(&fp)
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| fp.clone());

    let summary = meta
        .get("Summary")
        .or_else(|| meta.get("summary"))
        .map(unwrap_protojson_arg)
        .and_then(|v| v.as_str().map(str::to_string))
        .map(|s| s.trim().to_string())
        .unwrap_or_default();
    let user_facing = meta
        .get("UserFacing")
        .or_else(|| meta.get("userFacing"))
        .map(unwrap_protojson_arg)
        .and_then(|v| v.as_bool())
        .unwrap_or(true);
    let request_feedback = meta
        .get("RequestFeedback")
        .or_else(|| meta.get("requestFeedback"))
        .map(unwrap_protojson_arg)
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    if !user_facing && !request_feedback && summary.is_empty() {
        return None;
    }

    Some(SessionArtifact {
        path: fp,
        file_name,
        summary: truncate_chars(&summary, 1200),
        user_facing,
        request_feedback,
        updated_at: timestamp.to_string(),
    })
}

fn upsert_session_artifact(dst: &mut Vec<SessionArtifact>, incoming: SessionArtifact) {
    let norm = normalize_path_key(&incoming.path);
    if let Some(existing) = dst.iter_mut().find(|a| normalize_path_key(&a.path) == norm) {
        if !incoming.summary.is_empty() {
            existing.summary = incoming.summary;
        }
        existing.user_facing = incoming.user_facing;
        existing.request_feedback = incoming.request_feedback;
        existing.updated_at = incoming.updated_at;
    } else {
        dst.push(incoming);
    }
}

fn merge_question_exchange(dst: &mut Vec<QuestionExchange>, incoming: QuestionExchange) {
    if let Some(existing) = dst.iter_mut().find(|q| q.questions == incoming.questions) {
        let existing_has_ans = existing.answers.iter().any(|a| !a.trim().is_empty()) || existing.skipped;
        let incoming_has_ans = incoming.answers.iter().any(|a| !a.trim().is_empty()) || incoming.skipped;
        if incoming_has_ans && !existing_has_ans {
            existing.answers = incoming.answers;
            existing.skipped = incoming.skipped;
            existing.timestamp = incoming.timestamp;
        }
    } else {
        dst.push(incoming);
    }
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
        "ask_question" | "AskUserQuestion" => {
            let summary = extract_question_items(args)
                .and_then(|qs| qs.first().map(|q| truncate_chars(&q.question, 72)))
                .unwrap_or_else(|| "Question for user".into());
            Some(FormattedStepMeta {
                verb: "Asked".to_string(),
                summary,
                detail: None,
                file_path: None,
                line_range: None,
                start_line: None,
            })
        }
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
            let base = PathBuf::from(home).join(".gemini");
            for flavor in ["antigravity-cli", "antigravity"] {
                for filename in ["transcript.jsonl", "transcript_full.jsonl"] {
                    let candidate = base
                        .join(flavor)
                        .join("brain")
                        .join(conversation_id)
                        .join(".system_generated")
                        .join("logs")
                        .join(filename);
                    if candidate.is_file() {
                        return Some(candidate.to_string_lossy().to_string());
                    }
                }
            }
        }
    }
    None
}

fn is_antigravity_cli_transcript(path: &str) -> bool {
    path.replace('\\', "/")
        .to_ascii_lowercase()
        .contains("/.gemini/antigravity-cli/")
}

fn is_antigravity_app_transcript(path: &str) -> bool {
    let normalized = path.replace('\\', "/").to_ascii_lowercase();
    normalized.contains("/.gemini/antigravity/")
        && !normalized.contains("/.gemini/antigravity-cli/")
}

fn is_nova_cli_session_origin(
    transcript_path: Option<&str>,
    has_cli_conversation_id: bool,
    conversation_id: &str,
) -> bool {
    if transcript_path.is_some_and(is_antigravity_app_transcript) {
        return false;
    }
    transcript_path.is_some_and(is_antigravity_cli_transcript)
        || has_cli_conversation_id
        || conversation_id.starts_with("pending-")
}

fn is_cli_hook_event(env: &NormalizedHookEnvelope, transcript_path: Option<&str>) -> bool {
    transcript_path.is_some_and(is_antigravity_cli_transcript)
        || env.process_chain.iter().any(|process| {
            let name = process.name.rsplit(['\\', '/']).next().unwrap_or(&process.name);
            name.eq_ignore_ascii_case("agy.exe") || name.eq_ignore_ascii_case("agy")
        })
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
    question_exchanges: Vec<QuestionExchange>,
    artifacts: Vec<SessionArtifact>,
    detected_ide_permission: Option<String>,
    turns: Vec<SessionTurn>,
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

fn hook_completion_sound(cli_hook_event: bool) -> Option<&'static str> {
    cli_hook_event.then_some("ready")
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

fn read_untruncated_raw_step_content(compact_path: &Path, step_index: u64) -> Option<String> {
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
                        .map(|s| s.to_string());
                }
            }
        }
    }
    None
}

fn read_untruncated_step_content(compact_path: &Path, step_index: u64) -> Option<String> {
    read_untruncated_raw_step_content(compact_path, step_index)
        .and_then(|s| clean_assistant_output(&s))
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

    const TAIL_BYTES: u64 = 1_048_576;
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
    let mut collected_turns: Vec<SessionTurn> = Vec::new();
    let mut current_turn: Option<SessionTurn> = None;
    let mut pending_pre_text: Option<String> = None;
    let mut awaiting_question: Option<(Vec<QuestionItem>, String)> = None;

    let finalize_turn_snapshot = |turn: &mut SessionTurn,
                                  groups: &[FocusGroup],
                                  diffs: &[FileDiffPreview],
                                  questions: &[QuestionExchange],
                                  artifacts: &[SessionArtifact]| {
        let mut turn_groups = groups.to_vec();
        dedup_and_merge_focus_groups(&mut turn_groups);
        let fallback_end = turn.completed_at.clone().or_else(|| turn.started_at.clone());
        for g in &mut turn_groups {
            if g.ended_at.is_none() {
                g.ended_at = fallback_end.clone();
            }
        }
        let mut turn_diffs: Vec<FileDiffPreview> = diffs.iter().rev().cloned().collect();
        dedup_session_diffs(&mut turn_diffs);
        if !turn_diffs.is_empty() {
            turn.files_touched_count = turn_diffs.len();
        }
        turn.focus_groups = turn_groups;
        turn.diffs = turn_diffs;
        turn.question_exchanges = questions.to_vec();
        turn.artifacts = artifacts.to_vec();
    };

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
                    let content_truncated = obj
                        .get("truncated_fields")
                        .and_then(|v| v.as_array())
                        .is_some_and(|arr| arr.iter().any(|x| x.as_str() == Some("content")));
                    let untruncated = if content_truncated {
                        obj.get("step_index")
                            .and_then(|v| v.as_u64())
                            .and_then(|idx| read_untruncated_raw_step_content(path, idx))
                    } else {
                        None
                    };
                    let effective_c = untruncated.as_deref().unwrap_or(c);
                    if let Some(cleaned) = clean_user_prompt(effective_c) {
                        if let Some(mut prev) = current_turn.take() {
                            finalize_turn_snapshot(
                                &mut prev,
                                &out.focus_groups,
                                &out.diffs,
                                &out.question_exchanges,
                                &out.artifacts,
                            );
                            collected_turns.push(prev);
                        }
                        out.user_prompt = Some(cleaned.clone());
                        let turn_ts = obj
                            .get("created_at")
                            .and_then(|v| v.as_str())
                            .filter(|s| !s.is_empty())
                            .map(|s| s.to_string());
                        current_turn = Some(SessionTurn {
                            id: format!("turn-{}", collected_turns.len() + 1),
                            user_prompt: cleaned,
                            assistant_output: None,
                            thinking: None,
                            model_name: None,
                            tool_calls_count: 0,
                            files_touched_count: 0,
                            focus_groups: Vec::new(),
                            diffs: Vec::new(),
                            question_exchanges: Vec::new(),
                            artifacts: Vec::new(),
                            started_at: turn_ts,
                            completed_at: None,
                            is_active: false,
                        });
                    }
                    // Strictly scope steps, focus groups, diffs, notes & output to the CURRENT user turn only!
                    pending_pre_text = None;
                    awaiting_question = None;
                    out.plan_steps = None;
                    out.current_focus = None;
                    out.focus_groups.clear();
                    out.diffs.clear();
                    out.question_exchanges.clear();
                    out.artifacts.clear();
                    out.latest_thinking = None;
                    out.latest_output = None;
                    out.mid_process_note = None;
                }
            }
            continue;
        }

        if step_type == "GENERIC" {
            if let Some((q_items, q_ts)) = awaiting_question.take() {
                let raw_c = obj
                    .get("content")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default();
                let (answers, skipped) = parse_question_result_answers(raw_c, q_items.len());
                let ts = obj
                    .get("created_at")
                    .and_then(|v| v.as_str())
                    .filter(|s| !s.is_empty())
                    .map(|s| s.to_string())
                    .unwrap_or(q_ts);
                let next_qx_id = format!("qx-{}", out.question_exchanges.len() + 1);
                merge_question_exchange(
                    &mut out.question_exchanges,
                    QuestionExchange {
                        id: next_qx_id,
                        questions: q_items,
                        answers,
                        skipped,
                        timestamp: ts,
                    },
                );
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
                    out.model_name = Some(hm.clone());
                    if let Some(cur) = current_turn.as_mut() {
                        cur.model_name = Some(hm);
                    }
                }
            }
            if let Some(th) = obj.get("thinking").and_then(|v| v.as_str()) {
                if let Some(clean_th) = extract_latest_thinking_paragraph(th) {
                    out.latest_thinking = Some(clean_th.clone());
                    if let Some(cur) = current_turn.as_mut() {
                        cur.thinking = Some(clean_th);
                    }
                }
            }
            let tool_calls = obj.get("tool_calls").and_then(|v| v.as_array());
            let has_tool_calls = tool_calls.is_some_and(|a| !a.is_empty());

            let content_truncated = obj
                .get("truncated_fields")
                .and_then(|v| v.as_array())
                .is_some_and(|arr| arr.iter().any(|x| x.as_str() == Some("content")));

            if let Some(content) = obj.get("content").and_then(|v| v.as_str()) {
                let resolved_out = if content_truncated {
                    obj.get("step_index")
                        .and_then(|v| v.as_u64())
                        .and_then(|idx| read_untruncated_step_content(path, idx))
                        .or_else(|| clean_assistant_output(content))
                } else {
                    clean_assistant_output(content)
                };

                if let Some(clean_out) = resolved_out {
                    if has_tool_calls {
                        // Mid-turn commentary written by the agent alongside tool calls:
                        // attach as clean Markdown `pre_text` right above the upcoming tool/focus group
                        // (NEVER stuff full sentences into `mid_process_note` spinner pills!).
                        match pending_pre_text.as_mut() {
                            Some(existing) => {
                                existing.push_str("\n\n");
                                existing.push_str(&clean_out);
                            }
                            None => {
                                pending_pre_text = Some(clean_out);
                            }
                        }
                        out.mid_process_note = None;
                    } else {
                        let final_md = if let Some(prefix) = pending_pre_text.take() {
                            format!("{prefix}\n\n{clean_out}")
                        } else {
                            clean_out
                        };
                        out.latest_output = Some(final_md.clone());
                        out.mid_process_note = None;
                        if let Some(cur) = current_turn.as_mut() {
                            cur.assistant_output = Some(final_md);
                            cur.completed_at = Some(step_ts.clone());
                        }
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
                if let Some(cur) = current_turn.as_mut() {
                    cur.tool_calls_count += tcs.len();
                    for tc in tcs {
                        let name = tc.get("name").and_then(|v| v.as_str()).unwrap_or_default();
                        if name == "edit_file" || name == "write_file" || name == "Edit" || name == "Write" {
                            cur.files_touched_count += 1;
                        }
                    }
                }
                for tc in tcs {
                    let name = tc.get("name").and_then(|v| v.as_str()).unwrap_or_default();
                    let args = tc.get("args").unwrap_or(&Value::Null);
                    let call_id = tc.get("id").and_then(|v| v.as_str()).map(|s| s.to_string());

                    if matches!(name, "ask_question" | "AskUserQuestion") {
                        if let Some(qs) = extract_question_items(args) {
                            awaiting_question = Some((qs, step_ts.clone()));
                        }
                    }
                    if let Some(art) = extract_artifact_metadata(name, args, None, &step_ts) {
                        upsert_session_artifact(&mut out.artifacts, art);
                    }

                    if name == "update_focus" {
                        if let Some(f) = extract_focus_phrase(args) {
                            out.current_focus = Some(f.clone());
                            if let Some(prev) = out.focus_groups.last_mut() {
                                if prev.title.trim().eq_ignore_ascii_case(f.trim())
                                    && (prev.steps.is_empty() || pending_pre_text.is_none())
                                {
                                    prev.title = f;
                                    prev.explicit_focus = true;
                                    prev.ended_at = None;
                                    if let Some(pt) = pending_pre_text.take() {
                                        match prev.pre_text.as_mut() {
                                            Some(ex) => {
                                                ex.push_str("\n\n");
                                                ex.push_str(&pt);
                                            }
                                            None => prev.pre_text = Some(pt),
                                        }
                                    }
                                    continue;
                                } else if prev.steps.is_empty() {
                                    prev.title = f;
                                    prev.explicit_focus = true;
                                    prev.started_at = step_ts.clone();
                                    prev.ended_at = None;
                                    if let Some(pt) = pending_pre_text.take() {
                                        match prev.pre_text.as_mut() {
                                            Some(ex) => {
                                                ex.push_str("\n\n");
                                                ex.push_str(&pt);
                                            }
                                            None => prev.pre_text = Some(pt),
                                        }
                                    }
                                    continue;
                                } else if prev.ended_at.is_none() {
                                    prev.ended_at = Some(step_ts.clone());
                                }
                            }
                            out.focus_groups.push(FocusGroup {
                                id: format!("fg-{}", out.focus_groups.len() + 1),
                                title: f,
                                explicit_focus: true,
                                pre_text: pending_pre_text.take(),
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
                        let step_unified_diff = tr_diff.as_ref().map(|d| d.unified_diff.clone());
                        if let Some(mut dp) = tr_diff {
                            dp.timestamp = step_ts.clone();
                            out.diffs.push(dp);
                        }

                        // If the agent wrote new mid-turn prose before this tool call and the last group
                        // already ran steps, start a fresh group so prose stays interleaved in order!
                        if pending_pre_text.is_some() {
                            if let Some(prev) = out.focus_groups.last_mut() {
                                if !prev.steps.is_empty() && prev.ended_at.is_none() {
                                    prev.ended_at = Some(step_ts.clone());
                                }
                            }
                        }

                        let need_new = out
                            .focus_groups
                            .last()
                            .is_none_or(|g| g.ended_at.is_some());
                        if need_new {
                            out.focus_groups.push(FocusGroup {
                                id: format!("fg-{}", out.focus_groups.len() + 1),
                                title: out
                                    .current_focus
                                    .clone()
                                    .unwrap_or_else(|| "Working…".to_string()),
                                explicit_focus: out.current_focus.is_some(),
                                pre_text: pending_pre_text.take(),
                                started_at: step_ts.clone(),
                                ended_at: None,
                                steps: Vec::new(),
                            });
                        } else if let Some(pt) = pending_pre_text.take() {
                            if let Some(grp) = out.focus_groups.last_mut() {
                                match grp.pre_text.as_mut() {
                                    Some(ex) => {
                                        ex.push_str("\n\n");
                                        ex.push_str(&pt);
                                    }
                                    None => grp.pre_text = Some(pt),
                                }
                            }
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
                                unified_diff: step_unified_diff,
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

    // If agent emitted mid-turn text right before `update_steps` while still running (no tool group yet),
    // expose it cleanly in `latest_output` until final output arrives so it renders as white text immediately!
    if let Some(pending) = pending_pre_text.take() {
        if out.latest_output.is_none() {
            out.latest_output = Some(pending);
        }
    }

    if let Some(mut last) = current_turn.take() {
        finalize_turn_snapshot(
            &mut last,
            &out.focus_groups,
            &out.diffs,
            &out.question_exchanges,
            &out.artifacts,
        );
        collected_turns.push(last);
    }
    let total_turns = collected_turns.len();
    out.turns = collected_turns
        .into_iter()
        .enumerate()
        .map(|(idx, mut t)| {
            t.is_active = idx + 1 == total_turns;
            t
        })
        .collect();

    Some(out)
}

fn normalize_path_key(p: &str) -> String {
    p.replace('\\', "/")
        .trim_end_matches('/')
        .to_ascii_lowercase()
}

fn steps_represent_same_action(a: &SessionStep, b: &SessionStep) -> bool {
    if a.tool_name != b.tool_name
        || a.verb != b.verb
        || a.summary != b.summary
        || a.line_range != b.line_range
    {
        return false;
    }
    if let (Some(pa), Some(pb)) = (a.file_path.as_deref(), b.file_path.as_deref()) {
        if !pa.is_empty() && !pb.is_empty() && normalize_path_key(pa) != normalize_path_key(pb) {
            return false;
        }
    }
    if let (Some(da), Some(db)) = (a.detail.as_deref(), b.detail.as_deref()) {
        if !da.is_empty() && !db.is_empty() && da != db {
            return false;
        }
    }
    true
}

fn step_matches_meta(st: &SessionStep, tool_name: &str, meta: &FormattedStepMeta) -> bool {
    let same_tool = match st.tool_name.as_deref() {
        Some(t) if !t.is_empty() && !tool_name.is_empty() => t == tool_name,
        _ => true,
    };
    if !same_tool
        || st.verb != meta.verb
        || st.summary != meta.summary
        || st.line_range != meta.line_range
    {
        return false;
    }
    if let (Some(pa), Some(pb)) = (st.file_path.as_deref(), meta.file_path.as_deref()) {
        if !pa.is_empty() && !pb.is_empty() && normalize_path_key(pa) != normalize_path_key(pb) {
            return false;
        }
    }
    if let (Some(da), Some(db)) = (st.detail.as_deref(), meta.detail.as_deref()) {
        if !da.is_empty() && !db.is_empty() && da != db {
            return false;
        }
    }
    true
}

fn merge_step_into_vec(dst: &mut Vec<SessionStep>, incoming: SessionStep) {
    // 1. Exact call_id match -> update in-place
    if let Some(ref cid) = incoming.call_id {
        if let Some(existing) = dst.iter_mut().find(|s| s.call_id.as_ref() == Some(cid)) {
            if incoming.event != "Transcript" {
                existing.event = incoming.event;
                existing.status = incoming.status;
                existing.timestamp = incoming.timestamp;
            }
            if incoming.detail.is_some() {
                existing.detail = incoming.detail;
            }
            if incoming.file_path.is_some() {
                existing.file_path = incoming.file_path;
            }
            if incoming.start_line.is_some() {
                existing.start_line = incoming.start_line;
            }
            if incoming.added_lines.is_some() {
                existing.added_lines = incoming.added_lines;
                existing.removed_lines = incoming.removed_lines;
            }
            if incoming.unified_diff.is_some() {
                existing.unified_diff = incoming.unified_diff;
            }
            return;
        }
    }

    // 2. Real hook step (`call_id.is_some()`) upgrades an unclaimed `Transcript` placeholder 1-to-1
    if incoming.call_id.is_some() {
        if let Some(tr_slot) = dst.iter_mut().find(|s| {
            s.call_id.is_none()
                && s.event == "Transcript"
                && steps_represent_same_action(s, &incoming)
        }) {
            let saved_diff = tr_slot.unified_diff.take();
            *tr_slot = incoming;
            if tr_slot.unified_diff.is_none() {
                tr_slot.unified_diff = saved_diff;
            }
            return;
        }
    } else if incoming.event == "Transcript" {
        // Ignore a `Transcript` step if a real hook step for the same action is already present
        // and not yet paired with an earlier transcript placeholder.
        let hook_count = dst
            .iter()
            .filter(|s| s.call_id.is_some() && steps_represent_same_action(s, &incoming))
            .count();
        let tr_count = dst
            .iter()
            .filter(|s| {
                s.call_id.is_none()
                    && s.event == "Transcript"
                    && steps_represent_same_action(s, &incoming)
            })
            .count();
        if hook_count > tr_count {
            return;
        }
    }

    dst.push(incoming);
}

/// Merges consecutive `FocusGroup`s with identical titles and reconciles `Transcript` vs live hook steps.
fn dedup_and_merge_focus_groups(groups: &mut Vec<FocusGroup>) {
    if groups.is_empty() {
        return;
    }
    let old = std::mem::take(groups);
    let mut merged: Vec<FocusGroup> = Vec::with_capacity(old.len());

    for mut grp in old {
        let mut clean_steps = Vec::with_capacity(grp.steps.len());
        for st in grp.steps.drain(..) {
            merge_step_into_vec(&mut clean_steps, st);
        }
        grp.steps = clean_steps;
        if !grp.explicit_focus && !grp.steps.is_empty() {
            grp.title = auto_summarize_group_steps(&grp.steps);
        }

        // Do not merge across a new mid-turn prose block once `prev` already has steps,
        // so chronological interleaving (`steps -> AI prose -> next steps`) stays intact.
        let should_merge_with_prev = merged.last().is_some_and(|prev| {
            let can_combine = prev.steps.is_empty() || grp.pre_text.is_none();
            can_combine
                && (prev.title.trim().eq_ignore_ascii_case(grp.title.trim())
                    || (!prev.explicit_focus && prev.steps.is_empty()))
        });

        if should_merge_with_prev {
            if let Some(prev) = merged.last_mut() {
                if grp.explicit_focus {
                    prev.title = grp.title;
                    prev.explicit_focus = true;
                }
                if let Some(pt) = grp.pre_text {
                    match prev.pre_text.as_mut() {
                        Some(ex) if !ex.contains(pt.trim()) => {
                            ex.push_str("\n\n");
                            ex.push_str(&pt);
                        }
                        None => prev.pre_text = Some(pt),
                        _ => {}
                    }
                }
                // Preserve earliest started_at; take latest group's ended_at (None if still active)
                prev.ended_at = grp.ended_at;
                for st in grp.steps {
                    merge_step_into_vec(&mut prev.steps, st);
                }
                if prev.steps.len() > 500 {
                    let excess = prev.steps.len() - 500;
                    prev.steps.drain(0..excess);
                }
                if !prev.explicit_focus && !prev.steps.is_empty() {
                    prev.title = auto_summarize_group_steps(&prev.steps);
                }
            }
        } else {
            merged.push(grp);
        }
    }

    *groups = merged;
}

/// Deduplicates un-reverted `FileDiffPreview` entries with the same normalized path and unified diff.
fn dedup_session_diffs(diffs: &mut Vec<FileDiffPreview>) {
    if diffs.len() <= 1 {
        return;
    }
    // `diffs` is stored newest-first; keep the newest occurrence of an identical `(path, unified_diff)`.
    let mut seen: std::collections::HashSet<(String, String)> = std::collections::HashSet::new();
    diffs.retain(|d| {
        if d.reverted {
            return true;
        }
        let key = (normalize_path_key(&d.file_path), d.unified_diff.trim().to_string());
        seen.insert(key)
    });
}

/// Snapshots the active session's `focus_groups` and `diffs` onto the latest `SessionTurn`
/// before starting a new turn or finalizing, so past turns retain expandable logs & diffs.
fn snapshot_logs_into_latest_turn(sess: &mut AgentSession) {
    if let Some(last_turn) = sess.turns.last_mut() {
        if !sess.focus_groups.is_empty() {
            let mut fg_copy = sess.focus_groups.clone();
            for fg in &mut fg_copy {
                if fg.ended_at.is_none() {
                    fg.ended_at = Some(sess.updated_at.clone());
                }
                for st in &mut fg.steps {
                    if st.status == "running" {
                        st.status = "done".into();
                    }
                }
            }
            last_turn.focus_groups = fg_copy;
        }
        if !sess.diffs.is_empty() {
            last_turn.diffs = sess.diffs.clone();
            last_turn.files_touched_count = sess.diffs.len();
        }
        if !sess.question_exchanges.is_empty() {
            last_turn.question_exchanges = sess.question_exchanges.clone();
        }
        if !sess.artifacts.is_empty() {
            last_turn.artifacts = sess.artifacts.clone();
        }
        if last_turn.tool_calls_count == 0 && !last_turn.focus_groups.is_empty() {
            last_turn.tool_calls_count = last_turn.focus_groups.iter().map(|g| g.steps.len()).sum();
        }
    }
}

fn apply_insights_to_session(
    sess: &mut AgentSession,
    ins: TranscriptInsights,
    allow_structural_backfill: bool,
) -> bool {
    let mut changed = false;
    let prompt_changed = ins
        .user_prompt
        .as_deref()
        .is_some_and(|p| sess.last_user_input.as_deref() != Some(p));
    let stale_bg_transcript = sess.bg_running
        && !sess.turns.is_empty()
        && ins.turns.len() < sess.turns.len()
        && prompt_changed;

    if stale_bg_transcript {
        return false;
    }

    let turn_count_grew = !sess.turns.is_empty() && ins.turns.len() > sess.turns.len();
    let had_prior_prompt = sess.last_user_input.is_some();

    // If transcript moved to a brand-new user turn, archive prior turn logs before clearing!
    if (had_prior_prompt && prompt_changed) || turn_count_grew {
        snapshot_logs_into_latest_turn(sess);
        sess.focus_groups.clear();
        sess.steps.clear();
        sess.diffs.clear();
        sess.question_exchanges.clear();
        sess.artifacts.clear();
        sess.plan_steps.clear();
        sess.current_focus = None;
        if sess.bg_running || ins.latest_output.is_some() {
            sess.last_error = None;
        }
        changed = true;
    }

    if let Some(p) = ins.user_prompt {
        if prompt_changed {
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
    if ins.latest_output.is_some() || !sess.bg_running {
        if sess.latest_output != ins.latest_output {
            sess.latest_output = ins.latest_output;
            changed = true;
        }
    }
    if sess.status == "active" || sess.status == "waiting_approval" {
        if (ins.mid_process_note.is_some() || !sess.bg_running)
            && sess.mid_process_note != ins.mid_process_note
        {
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

    if !ins.question_exchanges.is_empty() {
        let before = sess.question_exchanges.clone();
        for qx in ins.question_exchanges {
            merge_question_exchange(&mut sess.question_exchanges, qx);
        }
        if sess.question_exchanges != before {
            changed = true;
        }
    }
    if !ins.artifacts.is_empty() {
        let before = sess.artifacts.clone();
        for art in ins.artifacts {
            upsert_session_artifact(&mut sess.artifacts, art);
        }
        if sess.artifacts != before {
            changed = true;
        }
    }

    if allow_structural_backfill {
        if sess.focus_groups.is_empty() && !ins.focus_groups.is_empty() {
            sess.focus_groups = ins.focus_groups;
            dedup_and_merge_focus_groups(&mut sess.focus_groups);
            changed = true;
        } else if !ins.focus_groups.is_empty() {
            for (idx, ig) in ins.focus_groups.iter().enumerate() {
                if let Some(sg) = sess.focus_groups.get_mut(idx) {
                    if sg.pre_text.is_none() && ig.pre_text.is_some() {
                        sg.pre_text = ig.pre_text.clone();
                        changed = true;
                    }
                }
            }
        }
        if sess.diffs.is_empty() && !ins.diffs.is_empty() {
            sess.diffs = ins.diffs.into_iter().rev().collect();
            dedup_session_diffs(&mut sess.diffs);
            sess.files_touched_count = sess.diffs.len();
            changed = true;
        }
    } else if !ins.focus_groups.is_empty() {
        // Even while live hooks manage steps, hydrate mid-turn AI `pre_text` and step `unified_diff` from transcript!
        for ig in &ins.focus_groups {
            if let Some(sg) = sess
                .focus_groups
                .iter_mut()
                .find(|g| g.title.trim().eq_ignore_ascii_case(ig.title.trim()) && g.pre_text.is_none())
            {
                if ig.pre_text.is_some() {
                    sg.pre_text = ig.pre_text.clone();
                    changed = true;
                }
            }
            for ist in &ig.steps {
                if ist.unified_diff.is_some() {
                    for sg in &mut sess.focus_groups {
                        if let Some(sst) = sg
                            .steps
                            .iter_mut()
                            .find(|s| s.unified_diff.is_none() && steps_represent_same_action(s, ist))
                        {
                            sst.unified_diff = ist.unified_diff.clone();
                            changed = true;
                        }
                    }
                }
            }
        }
    }
    if !ins.turns.is_empty() && ins.turns.len() >= sess.turns.len() {
        let mut next_turns = ins.turns;
        for (idx, nt) in next_turns.iter_mut().enumerate() {
            if let Some(prev_t) = sess.turns.get(idx) {
                if nt.focus_groups.is_empty() && !prev_t.focus_groups.is_empty() {
                    nt.focus_groups = prev_t.focus_groups.clone();
                }
                if nt.diffs.is_empty() && !prev_t.diffs.is_empty() {
                    nt.diffs = prev_t.diffs.clone();
                }
                if nt.question_exchanges.is_empty() && !prev_t.question_exchanges.is_empty() {
                    nt.question_exchanges = prev_t.question_exchanges.clone();
                }
                if nt.artifacts.is_empty() && !prev_t.artifacts.is_empty() {
                    nt.artifacts = prev_t.artifacts.clone();
                }
            }
        }
        if let Some(last) = next_turns.last_mut() {
            if last.assistant_output.is_none() && sess.latest_output.is_some() {
                last.assistant_output = sess.latest_output.clone();
            }
            if last.question_exchanges.is_empty() && !sess.question_exchanges.is_empty() {
                last.question_exchanges = sess.question_exchanges.clone();
            }
            if last.artifacts.is_empty() && !sess.artifacts.is_empty() {
                last.artifacts = sess.artifacts.clone();
            }
            last.is_active = sess.status == "active" || sess.status == "waiting_approval";
        }
        let same_turns = sess.turns.len() == next_turns.len()
            && sess.turns.iter().zip(next_turns.iter()).all(|(a, b)| {
                a.id == b.id
                    && a.user_prompt == b.user_prompt
                    && a.assistant_output == b.assistant_output
                    && a.thinking == b.thinking
                    && a.model_name == b.model_name
                    && a.tool_calls_count == b.tool_calls_count
                    && a.files_touched_count == b.files_touched_count
                    && a.question_exchanges == b.question_exchanges
                    && a.artifacts == b.artifacts
                    && a.is_active == b.is_active
            });
        if !same_turns {
            sess.turns = next_turns;
            changed = true;
        }
    }
    changed
}

impl InnerState {
    pub fn record_ai_request(
        &mut self,
        account: &str,
        tokens: Option<u64>,
        is_429: bool,
        error: Option<String>,
    ) {
        let history = if account == "second" {
            &mut self.quota_tracker.second
        } else {
            &mut self.quota_tracker.main
        };

        let now = std::time::Instant::now();
        let current_day = chrono::Utc::now().timestamp() as u64 / 86400;
        if history.daily_reset_epoch_day != current_day {
            history.daily_request_count = 0;
            history.total_tokens_today = 0;
            history.daily_reset_epoch_day = current_day;
        }

        while let Some(front) = history.minute_requests.front() {
            if now.duration_since(*front).as_secs() > 60 {
                history.minute_requests.pop_front();
            } else {
                break;
            }
        }

        history.minute_requests.push_back(now);
        history.daily_request_count = history.daily_request_count.saturating_add(1);
        if let Some(toks) = tokens {
            history.total_tokens_today = history.total_tokens_today.saturating_add(toks);
        }
        if is_429 {
            history.last_429 = Some(now);
            history.last_probe_status = Some("Quota limit exceeded (429 Too Many Requests)".to_string());
        } else if let Some(err) = error {
            history.last_probe_status = Some(err);
        } else {
            history.last_probe_status = None;
        }
    }

    pub fn compute_quota_state(&self) -> RealtimeQuotaState {
        let now = std::time::Instant::now();
        let current_day = chrono::Utc::now().timestamp() as u64 / 86400;

        let compute_for = |account_id: &str, account_name: &str, history: &AccountUsageHistory, has_key: bool| -> AccountQuotaInfo {
            let model = self.settings.default_chat_model.clone();
            let provider = self.settings.default_chat_provider.clone();

            let is_pro = model.contains("pro") || model.contains("opus");
            let (rpm_limit, rpd_limit, tpm_limit, tier) = if !has_key {
                (0, 0, 0, "Not Configured".to_string())
            } else if is_pro {
                (2, 50, 32_000, "Pro (Reasoning Tier)".to_string())
            } else {
                (15, 1500, 1_000_000, "Free / Standard Tier".to_string())
            };

            let rpm_used = history
                .minute_requests
                .iter()
                .filter(|t| now.duration_since(**t).as_secs() <= 60)
                .count() as u32;

            let rpd_used = if history.daily_reset_epoch_day == current_day {
                history.daily_request_count
            } else {
                0
            };

            let tokens_today = if history.daily_reset_epoch_day == current_day {
                history.total_tokens_today
            } else {
                0
            };

            let rpm_pct = if rpm_limit > 0 { (rpm_used as f32 / rpm_limit as f32) * 100.0 } else { 0.0 };
            let rpd_pct = if rpd_limit > 0 { (rpd_used as f32 / rpd_limit as f32) * 100.0 } else { 0.0 };
            let percentage_used = rpm_pct.max(rpd_pct).clamp(0.0, 100.0);

            let is_recent_429 = history
                .last_429
                .map(|t| now.duration_since(t).as_secs() < 60)
                .unwrap_or(false);

            let (status, last_error) = if !has_key {
                ("unconfigured".to_string(), Some("API Key not configured. Add in Settings -> AI & Keys".to_string()))
            } else if is_recent_429 || (rpm_limit > 0 && rpm_used >= rpm_limit) || (rpd_limit > 0 && rpd_used >= rpd_limit) {
                ("exceeded".to_string(), Some(format!("Quota limit reached on {account_name}. Switch account!")))
            } else if percentage_used >= 80.0 {
                ("warning".to_string(), Some(format!("High usage ({:.0}%). Consider switching account.", percentage_used)))
            } else {
                ("healthy".to_string(), None)
            };

            let oldest_in_window = history.minute_requests.iter().find(|t| now.duration_since(**t).as_secs() <= 60);
            let reset_in_seconds = oldest_in_window
                .map(|t| 60u64.saturating_sub(now.duration_since(*t).as_secs()))
                .unwrap_or(60);

            AccountQuotaInfo {
                account_id: account_id.to_string(),
                account_name: account_name.to_string(),
                provider,
                model,
                tier,
                rpm_limit,
                rpm_used,
                rpd_limit,
                rpd_used,
                tpm_limit,
                tpm_used: 0,
                total_tokens_today: tokens_today,
                percentage_used,
                status,
                reset_in_seconds,
                last_error,
                last_updated: chrono::Utc::now().to_rfc3339(),
            }
        };

        let has_gemini_main = crate::ai_services::get_secret("gemini").is_some() || std::env::var("GEMINI_API_KEY").is_ok();
        let has_gemini_second = crate::ai_services::get_secret("gemini_second").is_some() || std::env::var("GEMINI_API_KEY_SECOND").is_ok();

        let main = compute_for("main", &self.settings.main_account_name, &self.quota_tracker.main, has_gemini_main);
        let second = compute_for("second", &self.settings.second_account_name, &self.quota_tracker.second, has_gemini_second);

        RealtimeQuotaState {
            main,
            second,
            active_account: self.settings.active_account.clone(),
            active_model: self.settings.default_chat_model.clone(),
        }
    }
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
                workspace_path: None,
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
                pending_questions: Vec::new(),
                approval_waiters: HashMap::new(),
                question_waiters: HashMap::new(),
                pending_tool_diffs: HashMap::new(),
                bg_pids: HashMap::new(),
                warm_workers: HashMap::new(),
                embed_tickets: HashMap::new(),
                approval_rules: persisted.approval_rules,
                threads,
                personas,
                clipboard_history: Vec::new(),
                tech_dictionary,
                voice_snippets,
                voice_notes: persisted.voice_notes,
                focus: persisted.focus,
                analytics: persisted.analytics,
                quota_tracker: QuotaTracker::default(),
                ipc_token,
                pairing_token,
                lan_ip,
            })),
            sys: Arc::new(Mutex::new(sys)),
            events_tx,
            ui_liveness: Arc::new(Mutex::new(None)),
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
            .filter(|session| {
                is_nova_cli_session_origin(
                    session.transcript_path.as_deref(),
                    session.cli_conversation_id.is_some(),
                    &session.conversation_id,
                )
            })
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
            dedup_and_merge_focus_groups(&mut s.focus_groups);
            dedup_session_diffs(&mut s.diffs);
        }

        NovaSnapshot {
            version: env!("CARGO_PKG_VERSION").to_string(),
            settings: guard.settings.clone(),
            sessions: sessions_out,
            pending_approvals: guard.pending_approvals.clone(),
            pending_questions: guard.pending_questions.clone(),
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
            quota: guard.compute_quota_state(),
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
                let missing_tps: Vec<String> = {
                    let g = tr_core.inner.lock().unwrap();
                    g.sessions
                        .iter()
                        .take(6)
                        .filter(|s| {
                            s.transcript_path.is_none()
                                && !s.conversation_id.starts_with("pending-")
                        })
                        .map(|s| {
                            s.cli_conversation_id
                                .clone()
                                .unwrap_or_else(|| s.conversation_id.clone())
                        })
                        .collect()
                };
                if !missing_tps.is_empty() {
                    let discovered: Vec<(String, String)> = missing_tps
                        .into_iter()
                        .filter_map(|id| {
                            discover_transcript_path(&id, None, &Value::Null).map(|tp| (id, tp))
                        })
                        .collect();
                    if !discovered.is_empty() {
                        let mut g = tr_core.inner.lock().unwrap();
                        for (id, tp) in discovered {
                            if let Some(sess) = g.sessions.iter_mut().find(|s| {
                                s.conversation_id == id
                                    || s.cli_conversation_id.as_deref() == Some(id.as_str())
                            }) {
                                sess.transcript_path = Some(tp);
                            }
                        }
                    }
                }

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
                    let hooks_active = inspect_antigravity_hooks(false).nova_enabled;
                    let mut g = tr_core.inner.lock().unwrap();
                    for (cid, ins) in updates {
                        if let Some(sess) =
                            g.sessions.iter_mut().find(|s| s.conversation_id == cid)
                        {
                            let is_live_run =
                                sess.status == "active" || sess.status == "waiting_approval";
                            let allow_backfill = !is_live_run || !hooks_active;
                            if apply_insights_to_session(sess, ins, allow_backfill) {
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
        let cli_hook_event = is_cli_hook_event(&env, resolved_transcript.as_deref());
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
                    if !cli_hook_event {
                        return None;
                    }
                    g.sessions.iter().position(|s| {
                        s.conversation_id.starts_with("pending-")
                            && s.workspace_path
                                .trim_end_matches(['\\', '/'])
                                .eq_ignore_ascii_case(
                                    env.workspace_path.trim_end_matches(['\\', '/']),
                                )
                    })
                });

            let (idx, is_newly_discovered_session) = if let Some(pos) = session_pos {
                let old_id = g.sessions[pos].conversation_id.clone();
                if old_id.starts_with("pending-") && old_id != env.conversation_id {
                    g.sessions[pos].conversation_id = env.conversation_id.clone();
                    g.sessions[pos].cli_conversation_id = Some(env.conversation_id.clone());
                    if let Some(pid) = g.bg_pids.remove(&old_id) {
                        g.bg_pids.insert(env.conversation_id.clone(), pid);
                    }
                    if let Some(worker) = g.warm_workers.remove(&old_id) {
                        g.warm_workers.insert(env.conversation_id.clone(), worker);
                    }
                }
                (pos, false)
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
                        runtime_provider: None,
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
                        question_exchanges: Vec::new(),
                        artifacts: Vec::new(),
                        turns: Vec::new(),
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
                (0, true)
            };

            let mut early_reply: Option<HookRelayResponse> = None;
            let sess_perm_override: Option<String>;
            let is_warm_persistent = g
                .warm_workers
                .contains_key(&g.sessions[idx].conversation_id)
                || g.warm_workers.contains_key(&env.conversation_id)
                || g.sessions[idx]
                    .cli_conversation_id
                    .as_deref()
                    .is_some_and(|cid| g.warm_workers.contains_key(cid));

            {
                let sess = &mut g.sessions[idx];
                if !cli_hook_event
                    && resolved_transcript
                        .as_deref()
                        .is_some_and(is_antigravity_app_transcript)
                {
                    // A same-workspace app hook can arrive while a CLI run is pending.
                    // Never let that app conversation inherit the CLI identity.
                    sess.cli_conversation_id = None;
                }
                let was_finished_turn = matches!(
                    sess.status.as_str(),
                    "completed" | "error" | "idle"
                );
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
                // Reset prior-turn telemetry when starting a new turn on a completed session
                // (even if the user repeated the exact same prompt such as "continue").
                let new_prompt_arrived = cleaned_prompt
                    .as_ref()
                    .is_some_and(|p| sess.last_user_input.as_deref() != Some(p.as_str()));
                if new_prompt_arrived || (was_finished_turn && is_pre_inv && sess.queued_messages.is_empty()) {
                    snapshot_logs_into_latest_turn(sess);
                    if let Some(p) = &cleaned_prompt {
                        sess.last_user_input = Some(p.clone());
                    }
                    sess.latest_output = None;
                    sess.last_error = None;
                    sess.mid_process_note = None;
                    sess.current_focus = None;
                    sess.plan_steps.clear();
                    sess.focus_groups.clear();
                    sess.question_exchanges.clear();
                    sess.artifacts.clear();
                    sess.steps.clear();
                    sess.diffs.clear();
                }
                if resolved_transcript.is_some() {
                    sess.transcript_path = resolved_transcript.clone();
                }
                if let Some(ins) = transcript_insights {
                    // Only backfill focus_groups/diffs from transcript when attaching mid-turn to a
                    // newly discovered session or finalizing on `Stop`; during live PreToolUse/PostToolUse,
                    // hooks track running/waiting/done steps directly without premature transcript racing.
                    let allow_backfill = is_stop || is_newly_discovered_session;
                    let _ = apply_insights_to_session(sess, ins, allow_backfill);
                }
                if let Some(f) = focus_override {
                    sess.current_focus = Some(f.clone());
                    if is_pre_tool {
                        let promoted = if let Some(last_grp) = sess.focus_groups.last_mut() {
                            if last_grp.title.trim().eq_ignore_ascii_case(f.trim()) {
                                last_grp.title = f.clone();
                                last_grp.explicit_focus = true;
                                last_grp.ended_at = None;
                                true
                            } else if !last_grp.explicit_focus && last_grp.ended_at.is_none() {
                                last_grp.title = f.clone();
                                last_grp.explicit_focus = true;
                                last_grp.ended_at = None;
                                true
                            } else if last_grp.steps.is_empty() {
                                last_grp.title = f.clone();
                                last_grp.explicit_focus = true;
                                last_grp.started_at = now.clone();
                                last_grp.ended_at = None;
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
                                pre_text: None,
                                started_at: now.clone(),
                                ended_at: None,
                                steps: Vec::new(),
                            });
                            if sess.focus_groups.len() > 120 {
                                sess.focus_groups.remove(0);
                            }
                        }
                    }
                }
                if let Some(ps) = steps_override {
                    sess.plan_steps = ps;
                }
                if (is_pre_tool || is_post_tool) && !has_error {
                    if let Some(art) = extract_artifact_metadata(
                        &tool_name,
                        &env.tool_args,
                        env.target_file.as_deref(),
                        &now,
                    ) {
                        upsert_session_artifact(&mut sess.artifacts, art);
                    }
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
                        sess.last_user_input = Some(truncate_chars(&joined, 16_000));
                        sess.status = "active".into();
                        sess.phase = "thinking".into();
                        early_reply = Some(HookRelayResponse {
                            inject_user_message: Some(joined),
                            termination_behavior: Some("force_continue".into()),
                            ..Default::default()
                        });
                    } else if is_stop {
                        let joined = sess.queued_messages.drain(..).collect::<Vec<_>>().join("\n\n");
                        sess.last_user_input = Some(truncate_chars(&joined, 16_000));
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
                        if is_warm_persistent {
                            sess.status = "active".into();
                            sess.phase = if is_err_stop { "error" } else { "working" }.into();
                            sess.active_tool = None;
                            sess.mid_process_note = Some(if is_err_stop {
                                "Finalizing error details…".into()
                            } else {
                                "Finalizing response…".into()
                            });
                            sess.bg_running = true;
                        } else {
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
                        }
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
                    let step_unified_diff = effective_diff.as_ref().map(|d| d.unified_diff.clone());

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
                                summary: meta.summary.clone(),
                                detail: meta.detail.clone(),
                                verb: meta.verb.clone(),
                                file_path: meta.file_path.clone(),
                                line_range: meta.line_range.clone(),
                                start_line: step_start_line,
                                added_lines: step_added,
                                removed_lines: step_removed,
                                unified_diff: step_unified_diff.clone(),
                                status: "running".into(),
                                timestamp: now.clone(),
                            };
                            sess.steps.insert(0, new_step.clone());
                            sess.steps.truncate(250);

                            let already_in_groups = env.tool_call_id.as_ref().is_some_and(|cid| {
                                sess.focus_groups
                                    .iter()
                                    .any(|g| g.steps.iter().any(|st| st.call_id.as_ref() == Some(cid)))
                            });

                            if !already_in_groups {
                                // Upgrade a matching unclaimed `Transcript` placeholder step in-place if present
                                let mut claimed_transcript_step = false;
                                for grp in sess.focus_groups.iter_mut().rev() {
                                    if let Some(slot) = grp.steps.iter_mut().find(|st| {
                                        st.call_id.is_none()
                                            && st.event == "Transcript"
                                            && step_matches_meta(st, &tool_name, &meta)
                                    }) {
                                        let saved_diff = slot.unified_diff.take();
                                        *slot = new_step.clone();
                                        if slot.unified_diff.is_none() {
                                            slot.unified_diff = saved_diff;
                                        }
                                        grp.ended_at = None;
                                        if !grp.explicit_focus {
                                            grp.title = auto_summarize_group_steps(&grp.steps);
                                        }
                                        claimed_transcript_step = true;
                                        break;
                                    }
                                }

                                if !claimed_transcript_step {
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
                                            pre_text: None,
                                            started_at: now.clone(),
                                            ended_at: None,
                                            steps: Vec::new(),
                                        });
                                    }
                                    if let Some(grp) = sess.focus_groups.last_mut() {
                                        grp.steps.push(new_step);
                                        if grp.steps.len() > 500 {
                                            grp.steps.remove(0);
                                        }
                                        if !grp.explicit_focus {
                                            grp.title = auto_summarize_group_steps(&grp.steps);
                                        }
                                    }
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
                                matches!(st.status.as_str(), "running" | "waiting")
                                    && st.tool_name.as_deref() == Some(tool_name.as_str())
                            })
                        });

                        let final_status = if has_error { "error" } else { "done" };
                        let final_detail = if has_error {
                            env.error
                                .as_deref()
                                .map(|e| truncate_chars(e, 110))
                                .or(meta.detail.clone())
                        } else {
                            meta.detail.clone()
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
                            if step_unified_diff.is_some() {
                                sess.steps[pos].unified_diff = step_unified_diff.clone();
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
                                    unified_diff: step_unified_diff.clone(),
                                    status: final_status.into(),
                                    timestamp: now.clone(),
                                },
                            );
                            sess.steps.truncate(250);
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
                                    matches!(st.status.as_str(), "running" | "waiting")
                                        && st.tool_name.as_deref() == Some(tool_name.as_str())
                                })
                            })
                            .or_else(|| {
                                grp.steps.iter().position(|st| {
                                    st.call_id.is_none()
                                        && st.event == "Transcript"
                                        && step_matches_meta(st, &tool_name, &meta)
                                })
                            });

                            if let Some(gp) = gpos {
                                if grp.steps[gp].call_id.is_none() {
                                    grp.steps[gp].call_id = env.tool_call_id.clone();
                                }
                                grp.steps[gp].event = env.event.clone();
                                grp.steps[gp].status = final_status.into();
                                if final_detail.is_some() {
                                    grp.steps[gp].detail = final_detail.clone();
                                }
                                if meta.file_path.is_some() && grp.steps[gp].file_path.is_none() {
                                    grp.steps[gp].file_path = meta.file_path.clone();
                                }
                                if step_added.is_some() {
                                    grp.steps[gp].added_lines = step_added;
                                    grp.steps[gp].removed_lines = step_removed;
                                }
                                if step_start_line.is_some() {
                                    grp.steps[gp].start_line = step_start_line;
                                }
                                if step_unified_diff.is_some() {
                                    grp.steps[gp].unified_diff = step_unified_diff.clone();
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
                                let fallback_title = sess
                                    .current_focus
                                    .clone()
                                    .unwrap_or_else(|| "Working…".to_string());
                                let is_exp = sess.current_focus.is_some();
                                sess.focus_groups.push(FocusGroup {
                                    id: uuid::Uuid::new_v4().to_string(),
                                    title: fallback_title,
                                    explicit_focus: is_exp,
                                    pre_text: None,
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
                                    unified_diff: step_unified_diff,
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

                dedup_and_merge_focus_groups(&mut sess.focus_groups);

                if let Some(dp) = &effective_diff {
                    if is_post_tool && !has_error {
                        let norm_dp_path = normalize_path_key(&dp.file_path);
                        let trimmed_diff = dp.unified_diff.trim();
                        let dup_diff = sess.diffs.iter_mut().find(|existing| {
                            !existing.reverted
                                && normalize_path_key(&existing.file_path) == norm_dp_path
                                && existing.unified_diff.trim() == trimmed_diff
                        });
                        if let Some(existing) = dup_diff {
                            existing.timestamp = dp.timestamp.clone();
                            if dp.undo_target.is_some() {
                                existing.undo_target = dp.undo_target.clone();
                                existing.undo_replacement = dp.undo_replacement.clone();
                            }
                        } else {
                            sess.files_touched_count += 1;
                            sess.diffs.insert(0, dp.clone());
                            sess.diffs.truncate(60);
                        }
                    }
                }

                sess_perm_override = sess.permission_override.clone();
            }

            if is_stop && early_reply.is_none() && !is_warm_persistent {
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
            let has_warm_worker = {
                let g = self.inner.lock().unwrap();
                g.warm_workers.contains_key(&env.conversation_id)
                    || g.sessions.iter().any(|s| {
                        (s.conversation_id == env.conversation_id
                            || s.cli_conversation_id.as_deref()
                                == Some(env.conversation_id.as_str()))
                            && (g.warm_workers.contains_key(&s.conversation_id)
                                || s.cli_conversation_id
                                    .as_deref()
                                    .is_some_and(|c| g.warm_workers.contains_key(c)))
                    })
            };
            if !has_warm_worker {
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
                                        || s.cli_conversation_id.as_deref()
                                            == Some(stop_cid.as_str())
                                }) {
                                    changed = apply_insights_to_session(sess, ins, true);
                                }
                            }
                            if changed {
                                stop_core.broadcast_snapshot(None);
                            }
                        }
                    });
                }
                self.persist();
                self.broadcast_snapshot(hook_completion_sound(cli_hook_event));
            } else {
                self.persist();
                self.broadcast_snapshot(None);
            }
            return HookRelayResponse::default();
        }

        if !is_pre_tool {
            self.broadcast_snapshot(None);
            return HookRelayResponse::default();
        }

        // 0. Interactive `ask_question` / `AskUserQuestion` interception:
        //    Always surface multi-choice / open questions directly inside NOVA (even in `follow_agy`
        //    or `turbo` permission modes, and crucially in headless `agy.exe` stream-json runs where
        //    no IDE dialog exists!). Users can answer, dictate, skip, or click "Reply in IDE".
        if matches!(tool_name.as_str(), "ask_question" | "AskUserQuestion") {
            if let Some(questions) = extract_question_items(&env.tool_args) {
                let question_id = uuid::Uuid::new_v4().to_string();
                let (q_tx, q_rx) = oneshot::channel::<HookRelayResponse>();
                let target_conv_id = {
                    let mut g = self.inner.lock().unwrap();
                    let resolved_cid = g
                        .sessions
                        .iter()
                        .find(|s| {
                            s.conversation_id == env.conversation_id
                                || s.cli_conversation_id.as_deref()
                                    == Some(env.conversation_id.as_str())
                        })
                        .map(|s| s.conversation_id.clone())
                        .unwrap_or_else(|| env.conversation_id.clone());

                    if let Some(sess) = g
                        .sessions
                        .iter_mut()
                        .find(|s| s.conversation_id == resolved_cid)
                    {
                        sess.status = "waiting_approval".into();
                        sess.phase = "waiting_approval".into();
                        if let Some(st) = sess.steps.first_mut() {
                            if st.status == "running" {
                                st.status = "waiting".into();
                            }
                        }
                        for fg in sess.focus_groups.iter_mut().rev() {
                            if let Some(st) = fg.steps.last_mut() {
                                if st.status == "running" {
                                    st.status = "waiting".into();
                                    break;
                                }
                            }
                        }
                    }

                    g.pending_questions.insert(
                        0,
                        PendingQuestion {
                            id: question_id.clone(),
                            conversation_id: resolved_cid.clone(),
                            agent: env.agent.clone(),
                            workspace_path: env.workspace_path.clone(),
                            workspace_name: workspace_name.clone(),
                            git_branch: env.git_branch.clone(),
                            questions,
                            created_at: now.clone(),
                            expires_in_sec: 280,
                        },
                    );
                    g.question_waiters.insert(question_id.clone(), q_tx);
                    resolved_cid
                };

                self.broadcast_snapshot(Some("approval_needed"));

                return match tokio::time::timeout(std::time::Duration::from_secs(280), q_rx).await {
                    Ok(Ok(reply)) => reply,
                    _ => {
                        {
                            let mut g = self.inner.lock().unwrap();
                            g.pending_questions.retain(|q| q.id != question_id);
                            g.question_waiters.remove(&question_id);
                            if let Some(sess) = g
                                .sessions
                                .iter_mut()
                                .find(|s| s.conversation_id == target_conv_id)
                            {
                                sess.status = "active".into();
                                sess.phase = "working".into();
                            }
                        }
                        self.broadcast_snapshot(None);
                        HookRelayResponse {
                            decision: Some("ask".into()),
                            ..Default::default()
                        }
                    }
                };
            }
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

    pub fn resolve_question(
        &self,
        question_id: &str,
        answers: Vec<String>,
        skipped: bool,
        passthrough_to_ide: bool,
    ) -> Result<(), String> {
        let now_str = chrono::Utc::now().to_rfc3339();
        let sound_cue = if passthrough_to_ide {
            None
        } else {
            Some("approved")
        };

        {
            let mut g = self.inner.lock().unwrap();
            let pos = g
                .pending_questions
                .iter()
                .position(|q| q.id == question_id)
                .ok_or_else(|| "Question prompt already answered or expired".to_string())?;

            let pending = g.pending_questions.remove(pos);

            let normalized_answers: Vec<String> = (0..pending.questions.len())
                .map(|idx| {
                    answers
                        .get(idx)
                        .map(|s| s.trim().to_string())
                        .unwrap_or_default()
                })
                .collect();

            if let Some(sess) = g
                .sessions
                .iter_mut()
                .find(|s| s.conversation_id == pending.conversation_id)
            {
                sess.status = "active".into();
                sess.phase = "working".into();
                for st in &mut sess.steps {
                    if st.status == "waiting" {
                        st.status = if passthrough_to_ide { "running" } else { "done" }.into();
                    }
                }
                for fg in &mut sess.focus_groups {
                    for st in &mut fg.steps {
                        if st.status == "waiting" {
                            st.status = if passthrough_to_ide { "running" } else { "done" }.into();
                        }
                    }
                }
                if !passthrough_to_ide {
                    let qx = QuestionExchange {
                        id: pending.id.clone(),
                        questions: pending.questions.clone(),
                        answers: normalized_answers.clone(),
                        skipped,
                        timestamp: now_str.clone(),
                    };
                    merge_question_exchange(&mut sess.question_exchanges, qx.clone());
                    if let Some(turn) = sess.turns.last_mut() {
                        merge_question_exchange(&mut turn.question_exchanges, qx);
                    }
                }
            }

            let reply = if passthrough_to_ide {
                HookRelayResponse {
                    decision: Some("ask".into()),
                    ..Default::default()
                }
            } else if skipped
                || normalized_answers.iter().all(|a| a.trim().is_empty())
            {
                HookRelayResponse {
                    decision: Some("deny".into()),
                    reason: Some(
                        "The user skipped the ask_question prompt in NOVA. Proceed directly using your recommended default options without calling ask_question again."
                            .into(),
                    ),
                    ..Default::default()
                }
            } else {
                let mut lines = Vec::with_capacity(pending.questions.len());
                for (i, ans) in normalized_answers.iter().enumerate() {
                    let display_ans = if ans.is_empty() {
                        "(Skipped — use recommended default)"
                    } else {
                        ans.as_str()
                    };
                    lines.push(format!("A{}: {}", i + 1, display_ans));
                }
                HookRelayResponse {
                    decision: Some("deny".into()),
                    reason: Some(format!(
                        "The user answered your ask_question directly in NOVA:\n{}\nProceed directly using these authoritative answers — do NOT call ask_question again for these questions.",
                        lines.join("\n")
                    )),
                    ..Default::default()
                }
            };

            if let Some(waiter) = g.question_waiters.remove(question_id) {
                let _ = waiter.send(reply);
            }
        }

        self.persist();
        self.broadcast_snapshot(sound_cue);
        Ok(())
    }

    /// Safely reads a Markdown or text artifact file associated with a tracked session or Antigravity brain folder.
    pub fn read_session_artifact(
        &self,
        conversation_id: Option<&str>,
        file_path: &str,
    ) -> Result<String, String> {
        let trimmed = file_path.trim();
        if trimmed.is_empty() {
            return Err("Artifact file path is empty".to_string());
        }
        let target_path = Path::new(trimmed);
        let canonical_target = fs::canonicalize(target_path)
            .map_err(|_| "Artifact file does not exist on disk".to_string())?;
        if !canonical_target.is_file() {
            return Err("Path is not a regular file".to_string());
        }

        let norm_target = normalize_path_key(&canonical_target.to_string_lossy());
        let is_brain_artifact = norm_target.contains("/.gemini/antigravity/brain/")
            || norm_target.contains("/.gemini/antigravity-cli/brain/");

        let authorized = is_brain_artifact || {
            let g = self.inner.lock().unwrap();
            g.sessions.iter().any(|s| {
                if let Some(cid) = conversation_id.filter(|c| !c.trim().is_empty()) {
                    if s.conversation_id != cid
                        && s.cli_conversation_id.as_deref() != Some(cid)
                    {
                        return false;
                    }
                }
                let ws_canon = fs::canonicalize(&s.workspace_path)
                    .map(|p| normalize_path_key(&p.to_string_lossy()))
                    .unwrap_or_else(|_| normalize_path_key(&s.workspace_path));
                if !ws_canon.is_empty() && norm_target.starts_with(&format!("{ws_canon}/")) {
                    return true;
                }
                s.artifacts
                    .iter()
                    .chain(s.turns.iter().flat_map(|t| t.artifacts.iter()))
                    .any(|a| {
                        fs::canonicalize(&a.path)
                            .map(|p| normalize_path_key(&p.to_string_lossy()) == norm_target)
                            .unwrap_or_else(|_| normalize_path_key(&a.path) == norm_target)
                    })
            })
        };

        if !authorized {
            return Err("File is outside tracked session workspaces and Antigravity artifact directories".to_string());
        }

        let meta = fs::metadata(&canonical_target).map_err(|e| e.to_string())?;
        if meta.len() > 512_000 {
            return Err("Artifact exceeds 512 KB inline preview limit; open in IDE instead".to_string());
        }

        let content = fs::read_to_string(&canonical_target)
            .map_err(|e| format!("Failed reading artifact text: {e}"))?;
        Ok(content)
    }

    /// Mints (or reuses) a short-lived capability ticket for rendering a validated `.html` artifact
    /// inside an isolated `sandbox="allow-scripts"` iframe without exposing NOVA's IPC token.
    pub fn create_embed_ticket(
        &self,
        conversation_id: Option<&str>,
        file_path: &str,
        embed_id: &str,
        inline: bool,
    ) -> Result<String, String> {
        let clean_path = normalize_embed_file_path(file_path);
        if clean_path.is_empty() {
            return Err("Embed file path is empty".to_string());
        }
        let ext = Path::new(&clean_path)
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or_default()
            .to_ascii_lowercase();
        if ext != "html" && ext != "htm" {
            return Err("Only .html / .htm artifacts can be rendered in an embed frame".to_string());
        }

        // Validate authorization, existence, and 512 KB cap immediately
        let _ = self.read_session_artifact(conversation_id, &clean_path)?;

        let clean_cid = conversation_id
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string);
        let safe_embed_id: String = embed_id
            .chars()
            .filter(|c| c.is_ascii_alphanumeric() || matches!(*c, '-' | '_' | ':'))
            .take(80)
            .collect();
        let final_embed_id = if safe_embed_id.is_empty() {
            "nova-embed".to_string()
        } else {
            safe_embed_id
        };

        let now = std::time::Instant::now();
        let ttl = std::time::Duration::from_secs(1800);
        let min_reuse = std::time::Duration::from_secs(120);

        let mut g = self.inner.lock().unwrap();
        g.embed_tickets.retain(|_, v| v.expires_at > now);

        let norm_req = normalize_path_key(&clean_path);
        if let Some((existing_tok, entry)) = g.embed_tickets.iter_mut().find(|(_, v)| {
            normalize_path_key(&v.file_path) == norm_req
                && v.conversation_id == clean_cid
                && v.embed_id == final_embed_id
                && v.inline == inline
                && v.expires_at.saturating_duration_since(now) > min_reuse
        }) {
            entry.expires_at = now + ttl;
            return Ok(existing_tok.clone());
        }

        if g.embed_tickets.len() >= 128 {
            if let Some(oldest_key) = g
                .embed_tickets
                .iter()
                .min_by_key(|(_, v)| v.expires_at)
                .map(|(k, _)| k.clone())
            {
                g.embed_tickets.remove(&oldest_key);
            }
        }

        let ticket = format!(
            "{}{}",
            uuid::Uuid::new_v4().simple(),
            uuid::Uuid::new_v4().simple()
        );
        g.embed_tickets.insert(
            ticket.clone(),
            EmbedTicketEntry {
                file_path: clean_path,
                conversation_id: clean_cid,
                embed_id: final_embed_id,
                inline,
                expires_at: now + ttl,
            },
        );
        Ok(ticket)
    }

    /// Resolves an embed capability ticket and returns the HTML document augmented with Antigravity
    /// semantic theme CSS variables and an auto-sizing `postMessage` bridge.
    pub fn render_embed_ticket(&self, ticket: &str) -> Result<String, String> {
        let trimmed = ticket.trim();
        if trimmed.len() < 32 || trimmed.len() > 128 || !trimmed.chars().all(|c| c.is_ascii_hexdigit()) {
            return Err("Invalid embed ticket".to_string());
        }

        let entry = {
            let mut g = self.inner.lock().unwrap();
            let now = std::time::Instant::now();
            g.embed_tickets.retain(|_, v| v.expires_at > now);
            g.embed_tickets
                .get(trimmed)
                .cloned()
                .ok_or_else(|| "Embed ticket expired or not found".to_string())?
        };

        let raw_html = self.read_session_artifact(entry.conversation_id.as_deref(), &entry.file_path)?;
        Ok(inject_nova_embed_runtime(&raw_html, &entry.embed_id, entry.inline))
    }

    /// Finalizes active turn, step states, and session status after a stream result or process exit.
    fn finalize_session_turn(
        sess: &mut AgentSession,
        ok: bool,
        final_output: Option<&str>,
        err_msg: Option<String>,
        now_done: &str,
    ) {
        if let Some(out) = final_output.map(str::trim).filter(|s| !s.is_empty()) {
            sess.latest_output = Some(truncate_chars(out, 8_500));
        }
        sess.bg_running = false;
        sess.active_tool = None;
        sess.mid_process_note = None;
        sess.updated_at = now_done.to_string();

        for st in &mut sess.steps {
            if st.status == "running" {
                st.status = if ok { "done" } else { "error" }.into();
            }
        }
        for fg in &mut sess.focus_groups {
            if fg.ended_at.is_none() {
                fg.ended_at = Some(now_done.to_string());
            }
            for st in &mut fg.steps {
                if st.status == "running" {
                    st.status = if ok { "done" } else { "error" }.into();
                }
            }
        }
        for sa in &mut sess.subagents {
            sa.status = if ok { "completed" } else { "error" }.into();
        }
        snapshot_logs_into_latest_turn(sess);
        if let Some(turn) = sess.turns.iter_mut().rfind(|t| t.is_active) {
            turn.is_active = false;
            turn.completed_at = Some(now_done.to_string());
            if sess.latest_output.is_some() {
                turn.assistant_output = sess.latest_output.clone();
            }
            if sess.latest_thinking.is_some() {
                turn.thinking = sess.latest_thinking.clone();
            }
            if sess.model_name.is_some() {
                turn.model_name = sess.model_name.clone();
            }
        }
        if ok {
            sess.status = "completed".into();
            sess.phase = "done".into();
            sess.last_error = None;
        } else if sess.status != "completed" {
            sess.status = "error".into();
            sess.phase = "error".into();
            if let Some(err) = err_msg.filter(|s| !s.trim().is_empty()) {
                if err.to_ascii_lowercase().contains("trajectory not found") {
                    sess.cli_conversation_id = None;
                }
                sess.last_error = Some(truncate_chars(&err, 500));
            }
        }
    }

    /// Sends a prompt to an active session (live hook injection), warm stream worker, or new headless `agy.exe` worker.
    pub fn dispatch_agent_prompt(
        &self,
        workspace_path: &str,
        conversation_id: Option<&str>,
        prompt: &str,
        mode: Option<&str>,
        model: Option<&str>,
        effort: Option<&str>,
        requested_provider: Option<&str>,
        image_data_url: Option<&str>,
        images: Option<&[(String, Option<String>)]>,
    ) -> Result<Value, String> {
        let mut final_prompt = prompt.trim().to_string();
        let mut saved_paths: Vec<PathBuf> = Vec::new();

        if let Some(list) = images {
            for (durl, name_hint) in list.iter().take(8) {
                let trimmed = durl.trim();
                if trimmed.is_empty() {
                    continue;
                }
                if let Some(p) = save_image_data_url_to_disk(trimmed, name_hint.as_deref()) {
                    saved_paths.push(p);
                }
            }
        }
        if saved_paths.is_empty() {
            if let Some(durl) = image_data_url.map(str::trim).filter(|s| !s.is_empty()) {
                if let Some(p) = save_image_data_url_to_disk(durl, None) {
                    saved_paths.push(p);
                }
            }
        }

        if saved_paths.len() == 1 {
            let sp = saved_paths[0].to_string_lossy();
            if final_prompt.is_empty() {
                final_prompt = format!(
                    "Inspect the attached screenshot at `{sp}` using read_file and fix any visual or UI issue you find."
                );
            } else {
                final_prompt = format!(
                    "{final_prompt}\n\n[Attached Screenshot: `{sp}` — inspect this image file with read_file]"
                );
            }
        } else if saved_paths.len() > 1 {
            let bullets = saved_paths
                .iter()
                .map(|p| format!("- `{}`", p.to_string_lossy()))
                .collect::<Vec<_>>()
                .join("\n");
            if final_prompt.is_empty() {
                final_prompt = format!(
                    "Inspect the attached images using read_file and address what they show:\n{bullets}"
                );
            } else {
                final_prompt = format!(
                    "{final_prompt}\n\n[Attached Images — inspect each image file with read_file:\n{bullets}]"
                );
            }
        }

        if final_prompt.is_empty() {
            return Err("Prompt cannot be empty".to_string());
        }
        if final_prompt.len() > 20_000 {
            return Err("Prompt exceeds maximum length (20,000 chars)".to_string());
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

        // 2. Resolve the runtime attached to this chat (or the requested default).
        // The session's `agent` field separately identifies app/IDE-observed activity.
        let runtime_provider = {
            let g = self.inner.lock().unwrap();
            let existing_provider = conversation_id.and_then(|cid| {
                g.sessions
                    .iter()
                    .find(|s| s.conversation_id == cid || s.cli_conversation_id.as_deref() == Some(cid))
                    .and_then(|s| s.runtime_provider)
            });
            match existing_provider {
                Some(provider) => provider,
                None => AgentProvider::parse(requested_provider)?,
            }
        };
        let agent_cli = crate::agents::resolve_cli_path(runtime_provider).ok_or_else(|| {
            match runtime_provider {
                AgentProvider::Agy => "Antigravity CLI (agy.exe) not found in %LOCALAPPDATA%\\agy\\bin".to_string(),
            }
        })?;

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
                            "<NOVA_HANDOFF_CONTEXT>\nWorkspace: `{}`\nLast user request: {}\nLast assistant summary: {}\n</NOVA_HANDOFF_CONTEXT>\n\n",
                            s.workspace_name,
                            truncate_chars(prev_q, 400),
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

        let req_model: Option<String> = model
            .map(str::trim)
            .filter(|m| !m.is_empty() && !m.eq_ignore_ascii_case("auto"))
            .map(str::to_string);
        let req_effort: Option<String> = effort
            .map(str::trim)
            .filter(|e| matches!(*e, "low" | "medium" | "high" | "xhigh" | "max"))
            .map(str::to_string);
        let requested_display_model = req_model.as_deref().and_then(humanize_model_name);

        let prompt_for_agy = match ide_handoff_context.as_deref().filter(|s| !s.is_empty()) {
            Some(ctx) => format!("{ctx}{final_prompt}"),
            None => final_prompt.clone(),
        };
        let ndjson_line = format!(
            "{}\n",
            serde_json::to_string(&json!({
                "event": "user",
                "message": { "content": prompt_for_agy }
            }))
            .map_err(|e| format!("Failed serializing stream-json prompt: {e}"))?
        );

        let now = chrono::Utc::now().to_rfc3339();
        let summary_prompt = clean_user_prompt(&final_prompt)
            .unwrap_or_else(|| truncate_chars(&final_prompt, 16_000));

        // 1b. Reuse an idle compatible persistent stream-json worker (`Turn 2+` in ~3-6s!)
        let mut stale_worker_pids: Vec<u32> = Vec::new();
        let warm_candidate: Option<(String, String, u32, Arc<Mutex<std::process::ChildStdin>>)> = {
            let mut g = self.inner.lock().unwrap();
            let canonical = conversation_id
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .and_then(|cid| {
                    g.sessions
                        .iter()
                        .find(|s| {
                            s.conversation_id == cid || s.cli_conversation_id.as_deref() == Some(cid)
                        })
                        .map(|s| s.conversation_id.clone())
                });

            if let Some(ref canon) = canonical {
                let wk_key = if g.warm_workers.contains_key(canon) {
                    Some(canon.clone())
                } else {
                    resume_cli_cid
                        .as_ref()
                        .filter(|c| g.warm_workers.contains_key(*c))
                        .cloned()
                };
                if let Some(key) = wk_key {
                    let compatible = g.warm_workers.get(&key).is_some_and(|w| {
                        let same_ws = normalize_path_key(&w.workspace_path)
                            == normalize_path_key(&clean_ws);
                        let model_ok = match req_model.as_deref() {
                            None => true,
                            Some(rm) => w.model.as_deref() == Some(rm),
                        };
                        let effort_ok = match req_effort.as_deref() {
                            None => true,
                            Some(re) => {
                                w.model
                                    .as_deref()
                                    .is_some_and(crate::system_tools::model_slug_has_effort_suffix)
                                    || w.effort.as_deref() == Some(re)
                            }
                        };
                        !w.turn_active
                            && same_ws
                            && w.mode == agy_mode
                            && w.skip_permissions == skip_perms
                            && model_ok
                            && effort_ok
                    });
                    if compatible {
                        if let Some(w) = g.warm_workers.get_mut(&key) {
                            w.turn_active = true;
                            w.last_used_at = std::time::Instant::now();
                            let w_pid = w.pid;
                            let w_stdin = w.stdin.clone();
                            g.bg_pids.insert(canon.clone(), w_pid);
                            if let Some(sess) =
                                g.sessions.iter_mut().find(|s| s.conversation_id == *canon)
                            {
                                snapshot_logs_into_latest_turn(sess);
                                sess.status = "active".into();
                                sess.phase = "thinking".into();
                                sess.bg_running = true;
                                sess.runtime_provider = Some(runtime_provider);
                                sess.stop_requested = false;
                                sess.last_user_input = Some(summary_prompt.clone());
                                for prev_turn in &mut sess.turns {
                                    prev_turn.is_active = false;
                                }
                                sess.turns.push(SessionTurn {
                                    id: format!("turn-{}", sess.turns.len() + 1),
                                    user_prompt: summary_prompt.clone(),
                                    assistant_output: None,
                                    thinking: None,
                                    model_name: requested_display_model
                                        .clone()
                                        .or_else(|| sess.model_name.clone()),
                                    tool_calls_count: 0,
                                    files_touched_count: 0,
                                    focus_groups: Vec::new(),
                                    diffs: Vec::new(),
                                    question_exchanges: Vec::new(),
                                    artifacts: Vec::new(),
                                    started_at: Some(now.clone()),
                                    completed_at: None,
                                    is_active: true,
                                });
                                sess.latest_output = None;
                                sess.last_error = None;
                                sess.mid_process_note = Some("Warm session — reasoning…".into());
                                sess.current_focus = None;
                                if ide_perm_live.is_some() {
                                    sess.detected_ide_permission = ide_perm_live.clone();
                                }
                                sess.plan_steps.clear();
                                sess.focus_groups.clear();
                                sess.question_exchanges.clear();
                                sess.artifacts.clear();
                                sess.steps.clear();
                                sess.diffs.clear();
                                sess.updated_at = now.clone();
                            }
                            Some((canon.clone(), key, w_pid, w_stdin))
                        } else {
                            None
                        }
                    } else {
                        if let Some(old_w) = g.warm_workers.remove(&key) {
                            g.bg_pids.remove(&key);
                            g.bg_pids.remove(canon);
                            stale_worker_pids.push(old_w.pid);
                        }
                        None
                    }
                } else {
                    None
                }
            } else {
                None
            }
        };

        for old_pid in stale_worker_pids {
            let _ = kill_owned_child_tree(old_pid);
        }

        if let Some((canonical_cid, worker_key, w_pid, w_stdin)) = warm_candidate {
            let write_ok = {
                let mut pipe = w_stdin.lock().unwrap();
                pipe.write_all(ndjson_line.as_bytes()).is_ok() && pipe.flush().is_ok()
            };
            if write_ok {
                self.broadcast_snapshot(Some("step"));
                return Ok(json!({
                    "ok": true,
                    "delivery": "warm_agy_stream",
                    "conversationId": canonical_cid,
                    "pid": w_pid
                }));
            }
            // Broken pipe on warm worker: clean up and fall through to respawn cleanly.
            let dead_pid = {
                let mut g = self.inner.lock().unwrap();
                g.bg_pids.remove(&worker_key);
                g.bg_pids.remove(&canonical_cid);
                if let Some(sess) = g
                    .sessions
                    .iter_mut()
                    .find(|s| s.conversation_id == canonical_cid)
                {
                    if sess
                        .turns
                        .last()
                        .is_some_and(|t| t.is_active && t.assistant_output.is_none())
                    {
                        sess.turns.pop();
                    }
                }
                g.warm_workers.remove(&worker_key).map(|w| w.pid)
            };
            if let Some(dp) = dead_pid {
                let _ = kill_owned_child_tree(dp);
            }
        }

        // Cap warm workers to max 4 idle processes before spawning a new one
        let evicted_pids: Vec<u32> = {
            let mut g = self.inner.lock().unwrap();
            let mut evicted = Vec::new();
            while g.warm_workers.len() >= 4 {
                let oldest_idle = g
                    .warm_workers
                    .iter()
                    .filter(|(_, w)| !w.turn_active)
                    .min_by_key(|(_, w)| w.last_used_at)
                    .map(|(k, _)| k.clone());
                let Some(ev_key) = oldest_idle else {
                    break;
                };
                if let Some(old_w) = g.warm_workers.remove(&ev_key) {
                    g.bg_pids.remove(&ev_key);
                    evicted.push(old_w.pid);
                }
            }
            evicted
        };
        for ev_pid in evicted_pids {
            let _ = kill_owned_child_tree(ev_pid);
        }

        let mut child = crate::agents::spawn_turn(
            runtime_provider,
            &agent_cli,
            &dir_buf,
            resume_cli_cid.as_deref(),
            &prompt_for_agy,
            agy_mode,
            req_model.as_deref(),
            req_effort.as_deref(),
            skip_perms,
            true,
        )?;
        let pid = child.id();
        let Some(mut child_stdin) = child.stdin.take() else {
            let _ = kill_owned_child_tree(pid);
            return Err("Failed to capture stdin for persistent agy.exe worker".to_string());
        };
        if child_stdin.write_all(ndjson_line.as_bytes()).is_err() || child_stdin.flush().is_err() {
            let _ = kill_owned_child_tree(pid);
            return Err("Failed writing initial prompt to persistent agy.exe stdin".to_string());
        }
        let worker_stdin = Arc::new(Mutex::new(child_stdin));
        let child_stdout = child.stdout.take();
        let child_stderr = child.stderr.take();

        let tracked_cid = {
            let mut g = self.inner.lock().unwrap();
            let existing_cid = conversation_id
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .and_then(|cid| {
                    g.sessions
                        .iter()
                        .find(|s| {
                            s.conversation_id == cid || s.cli_conversation_id.as_deref() == Some(cid)
                        })
                        .map(|s| s.conversation_id.clone())
                });

            let resolved_cid = if let Some(canonical) = existing_cid {
                if let Some(sess) = g
                    .sessions
                    .iter_mut()
                    .find(|s| s.conversation_id == canonical)
                {
                    snapshot_logs_into_latest_turn(sess);
                    sess.status = "active".into();
                    sess.phase = "thinking".into();
                    sess.bg_running = true;
                    sess.runtime_provider = Some(runtime_provider);
                    sess.stop_requested = false;
                    sess.last_user_input = Some(summary_prompt.clone());
                    if let Some(m) = requested_display_model.clone() {
                        sess.model_name = Some(m);
                    }
                    for prev_turn in &mut sess.turns {
                        prev_turn.is_active = false;
                    }
                    sess.turns.push(SessionTurn {
                        id: format!("turn-{}", sess.turns.len() + 1),
                        user_prompt: summary_prompt.clone(),
                        assistant_output: None,
                        thinking: None,
                        model_name: requested_display_model
                            .clone()
                            .or_else(|| sess.model_name.clone()),
                        tool_calls_count: 0,
                        files_touched_count: 0,
                        focus_groups: Vec::new(),
                        diffs: Vec::new(),
                        question_exchanges: Vec::new(),
                        artifacts: Vec::new(),
                        started_at: Some(now.clone()),
                        completed_at: None,
                        is_active: true,
                    });
                    sess.latest_output = None;
                    sess.last_error = None;
                    sess.mid_process_note = Some("Starting Antigravity CLI…".into());
                    sess.current_focus = None;
                    if ide_perm_live.is_some() {
                        sess.detected_ide_permission = ide_perm_live.clone();
                    }
                    sess.plan_steps.clear();
                    sess.focus_groups.clear();
                    sess.question_exchanges.clear();
                    sess.artifacts.clear();
                    sess.steps.clear();
                    sess.diffs.clear();
                    sess.updated_at = now.clone();
                }
                canonical
            } else {
                let pending_id = format!("pending-{}", uuid::Uuid::new_v4().simple());
                g.sessions.insert(
                    0,
                    AgentSession {
                        conversation_id: pending_id.clone(),
                        agent: "antigravity".into(),
                        runtime_provider: Some(runtime_provider),
                        workspace_path: clean_ws.clone(),
                        workspace_name: ws_name,
                        git_branch: detect_git_branch_for_dir(&clean_ws),
                        model_name: requested_display_model.clone(),
                        last_user_input: Some(summary_prompt.clone()),
                        status: "active".into(),
                        phase: "thinking".into(),
                        current_focus: None,
                        mid_process_note: Some("Starting Antigravity CLI…".into()),
                        latest_thinking: None,
                        latest_output: None,
                        plan_steps: Vec::new(),
                        focus_groups: Vec::new(),
                        question_exchanges: Vec::new(),
                        artifacts: Vec::new(),
                        turns: vec![SessionTurn {
                            id: "turn-1".into(),
                            user_prompt: summary_prompt,
                            assistant_output: None,
                            thinking: None,
                            model_name: requested_display_model.clone(),
                            tool_calls_count: 0,
                            files_touched_count: 0,
                            focus_groups: Vec::new(),
                            diffs: Vec::new(),
                            question_exchanges: Vec::new(),
                            artifacts: Vec::new(),
                            started_at: Some(now.clone()),
                            completed_at: None,
                            is_active: true,
                        }],
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
            };

            g.bg_pids.insert(resolved_cid.clone(), pid);
            g.warm_workers.insert(
                resolved_cid.clone(),
                WarmAgyWorker {
                    pid,
                    stdin: worker_stdin.clone(),
                    mode: agy_mode.to_string(),
                    model: req_model,
                    effort: req_effort,
                    workspace_path: clean_ws,
                    skip_permissions: skip_perms,
                    turn_active: true,
                    last_used_at: std::time::Instant::now(),
                },
            );
            resolved_cid
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

        // Stream NDJSON events from persistent `agy.exe --input-format stream-json --output-format stream-json`
        let reaper_core = self.clone();
        tokio::task::spawn_blocking(move || {
            let mut active_cid = tracked_cid;
            let mut streamed_text = String::new();
            let mut captured_stdout_err: Option<String> = None;
            let mut last_broadcast = std::time::Instant::now();

            if let Some(out_stream) = child_stdout {
                for line in BufReader::new(out_stream).lines().map_while(Result::ok) {
                    let trimmed = line.trim();
                    if trimmed.is_empty() {
                        continue;
                    }
                    if !trimmed.starts_with('{') {
                        if let Some(rest) = trimmed.strip_prefix("AGY_ERROR:") {
                            if let Ok(v) = serde_json::from_str::<Value>(rest.trim()) {
                                if let Some(se) = v.get("short_error").and_then(|s| s.as_str()).map(str::trim).filter(|s| !s.is_empty()) {
                                    captured_stdout_err = Some(se.to_string());
                                }
                            }
                        } else if let Some(rest) = trimmed.strip_prefix("error:") {
                            let msg = rest.trim();
                            if !msg.is_empty() && captured_stdout_err.is_none() {
                                captured_stdout_err = Some(msg.to_string());
                            }
                        }
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
                            let init_model = ev
                                .get("init")
                                .and_then(|i| i.get("model"))
                                .or_else(|| ev.get("model"))
                                .and_then(|v| v.as_str())
                                .and_then(humanize_model_name);
                            let mut g = reaper_core.inner.lock().unwrap();
                            let pid_cid = g
                                .bg_pids
                                .iter()
                                .find(|(_, &p)| p == pid)
                                .map(|(k, _)| k.clone())
                                .or_else(|| {
                                    g.warm_workers
                                        .iter()
                                        .find(|(_, w)| w.pid == pid)
                                        .map(|(k, _)| k.clone())
                                });
                            let mut promoted_pair: Option<(String, String)> = None;
                            if let Some(sess) = g.sessions.iter_mut().find(|s| {
                                s.conversation_id == active_cid
                                    || pid_cid.as_deref() == Some(s.conversation_id.as_str())
                                    || cli_cid.as_deref().is_some_and(|c| {
                                        s.conversation_id == c
                                            || s.cli_conversation_id.as_deref() == Some(c)
                                    })
                            }) {
                                if let Some(ref cid_val) = cli_cid {
                                    sess.cli_conversation_id = Some(cid_val.clone());
                                    if sess.conversation_id.starts_with("pending-") {
                                        let old = sess.conversation_id.clone();
                                        sess.conversation_id = cid_val.clone();
                                        promoted_pair = Some((old, cid_val.clone()));
                                    }
                                }
                                active_cid = sess.conversation_id.clone();
                                if let Some(m) = init_model {
                                    sess.model_name = Some(m.clone());
                                    if let Some(t) = sess.turns.iter_mut().rfind(|t| t.is_active) {
                                        t.model_name = Some(m);
                                    }
                                }
                                if sess.transcript_path.is_none() {
                                    sess.transcript_path = discover_transcript_path(
                                        &sess.conversation_id,
                                        None,
                                        &Value::Null,
                                    )
                                    .or_else(|| {
                                        cli_cid.as_deref().and_then(|c| {
                                            discover_transcript_path(c, None, &Value::Null)
                                        })
                                    });
                                }
                                sess.mid_process_note =
                                    Some("Connected — preparing prompt…".into());
                                sess.updated_at = chrono::Utc::now().to_rfc3339();
                                should_broadcast = true;
                            }
                            if let Some((old, new_id)) = promoted_pair {
                                if let Some(p) = g.bg_pids.remove(&old) {
                                    g.bg_pids.insert(new_id.clone(), p);
                                }
                                if let Some(w) = g.warm_workers.remove(&old) {
                                    g.warm_workers.insert(new_id, w);
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
                                let tool_name = su
                                    .get("tool_name")
                                    .or_else(|| su.get("name"))
                                    .and_then(|v| v.as_str())
                                    .map(str::trim)
                                    .filter(|s| !s.is_empty());
                                let mut g = reaper_core.inner.lock().unwrap();
                                let pid_cid = g
                                    .bg_pids
                                    .iter()
                                    .find(|(_, &p)| p == pid)
                                    .map(|(k, _)| k.clone());
                                if let Some(sess) = g.sessions.iter_mut().find(|s| {
                                    s.conversation_id == active_cid
                                        || pid_cid.as_deref() == Some(s.conversation_id.as_str())
                                }) {
                                    active_cid = sess.conversation_id.clone();
                                    if !delta.is_empty() {
                                        streamed_text.push_str(delta);
                                        let truncated = truncate_chars(streamed_text.trim(), 8_500);
                                        sess.latest_output = Some(truncated.clone());
                                        if let Some(t) = sess.turns.iter_mut().rfind(|t| t.is_active) {
                                            t.assistant_output = Some(truncated);
                                        }
                                        sess.phase = "working".into();
                                        sess.mid_process_note = None;
                                        sess.updated_at = chrono::Utc::now().to_rfc3339();
                                        if last_broadcast.elapsed().as_millis() >= 120 {
                                            should_broadcast = true;
                                        }
                                    } else {
                                        match step_type {
                                            "user_input" => {
                                                sess.phase = "thinking".into();
                                                sess.mid_process_note =
                                                    Some("Prompt accepted — reasoning…".into());
                                                sess.updated_at = chrono::Utc::now().to_rfc3339();
                                                should_broadcast = true;
                                            }
                                            "tool" => {
                                                sess.phase = "working".into();
                                                if let Some(tname) = tool_name {
                                                    sess.active_tool = Some(tname.to_string());
                                                    sess.mid_process_note =
                                                        Some(format!("Running {tname}…"));
                                                } else {
                                                    sess.mid_process_note =
                                                        Some("Running tool…".into());
                                                }
                                                sess.updated_at = chrono::Utc::now().to_rfc3339();
                                                should_broadcast = true;
                                            }
                                            "agent_response" if streamed_text.is_empty() => {
                                                sess.phase = "working".into();
                                                sess.mid_process_note =
                                                    Some("Generating response…".into());
                                                sess.updated_at = chrono::Utc::now().to_rfc3339();
                                                should_broadcast = true;
                                            }
                                            "error_message" => {
                                                sess.phase = "error".into();
                                                sess.mid_process_note =
                                                    Some("Finalizing error details…".into());
                                                sess.updated_at = chrono::Utc::now().to_rfc3339();
                                                should_broadcast = true;
                                            }
                                            _ => {}
                                        }
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

                                let turn_ok = status_str.eq_ignore_ascii_case("SUCCESS")
                                    || (resp_str.is_some() && err_str.is_none());
                                let err_for_turn = err_str
                                    .map(str::to_string)
                                    .or_else(|| {
                                        (!turn_ok)
                                            .then(|| captured_stdout_err.clone())
                                            .flatten()
                                    })
                                    .or_else(|| {
                                        (!turn_ok).then(|| {
                                            "Antigravity CLI returned an error.".to_string()
                                        })
                                    });
                                let fallback_stream = (!streamed_text.trim().is_empty())
                                    .then(|| streamed_text.trim().to_string());
                                let final_out =
                                    resp_str.map(str::to_string).or(fallback_stream);
                                let now_done = chrono::Utc::now().to_rfc3339();

                                let mut tp_to_backfill: Option<String> = None;
                                {
                                    let mut g = reaper_core.inner.lock().unwrap();
                                    let pid_cid = g
                                        .bg_pids
                                        .iter()
                                        .find(|(_, &p)| p == pid)
                                        .map(|(k, _)| k.clone());
                                    if let Some(sess) = g.sessions.iter_mut().find(|s| {
                                        s.conversation_id == active_cid
                                            || pid_cid.as_deref() == Some(s.conversation_id.as_str())
                                    }) {
                                        active_cid = sess.conversation_id.clone();
                                        Self::finalize_session_turn(
                                            sess,
                                            turn_ok,
                                            final_out.as_deref(),
                                            err_for_turn.clone(),
                                            &now_done,
                                        );
                                        if sess.transcript_path.is_none() {
                                            sess.transcript_path = discover_transcript_path(
                                                &sess.conversation_id,
                                                None,
                                                &Value::Null,
                                            )
                                            .or_else(|| {
                                                sess.cli_conversation_id.as_deref().and_then(|c| {
                                                    discover_transcript_path(c, None, &Value::Null)
                                                })
                                            });
                                        }
                                        tp_to_backfill = sess.transcript_path.clone();
                                    }
                                    if turn_ok {
                                        if let Some(w) = g.warm_workers.get_mut(&active_cid) {
                                            w.turn_active = false;
                                            w.last_used_at = std::time::Instant::now();
                                        }
                                    } else {
                                        // `agy.exe` shuts down on error results, so evict the worker handle right away.
                                        g.warm_workers.remove(&active_cid);
                                        g.warm_workers.retain(|_, w| w.pid != pid);
                                        g.bg_pids.remove(&active_cid);
                                        g.bg_pids.retain(|_, &mut p| p != pid);
                                    }
                                }

                                reaper_core.persist();
                                reaper_core.broadcast_snapshot(Some(if turn_ok {
                                    "ready"
                                } else {
                                    "denied"
                                }));

                                if let Some(tp) = tp_to_backfill {
                                    let bf_core = reaper_core.clone();
                                    let bf_cid = active_cid.clone();
                                    tokio::spawn(async move {
                                        tokio::time::sleep(std::time::Duration::from_millis(180))
                                            .await;
                                        if let Ok(Some(ins)) = tokio::task::spawn_blocking(move || {
                                            read_transcript_insights(&tp)
                                        })
                                        .await
                                        {
                                            let mut changed = false;
                                            {
                                                let mut g = bf_core.inner.lock().unwrap();
                                                if let Some(sess) =
                                                    g.sessions.iter_mut().find(|s| {
                                                        s.conversation_id == bf_cid
                                                            || s.cli_conversation_id.as_deref()
                                                                == Some(bf_cid.as_str())
                                                    })
                                                {
                                                    changed =
                                                        apply_insights_to_session(sess, ins, true);
                                                }
                                            }
                                            if changed {
                                                bf_core.broadcast_snapshot(None);
                                            }
                                        }
                                    });
                                }

                                // Reset per-turn buffers and keep reading stdout for subsequent warm turns.
                                streamed_text.clear();
                                captured_stdout_err = None;
                                last_broadcast = std::time::Instant::now();
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

            let final_ok = exit_ok;
            let now_done = chrono::Utc::now().to_rfc3339();
            let mut changed = false;
            {
                let mut g = reaper_core.inner.lock().unwrap();
                let matching_cid = g
                    .bg_pids
                    .iter()
                    .find(|(_, &p)| p == pid)
                    .map(|(k, _)| k.clone())
                    .or_else(|| {
                        g.warm_workers
                            .iter()
                            .find(|(_, w)| w.pid == pid)
                            .map(|(k, _)| k.clone())
                    })
                    .unwrap_or_else(|| active_cid.clone());
                g.bg_pids.remove(&matching_cid);
                g.warm_workers.remove(&matching_cid);
                g.bg_pids.retain(|_, &mut p| p != pid);
                g.warm_workers.retain(|_, w| w.pid != pid);

                if let Some(sess) = g
                    .sessions
                    .iter_mut()
                    .find(|s| s.conversation_id == matching_cid || s.conversation_id == active_cid)
                {
                    // Only finalize on process exit if a turn was actually still running without a `result` event.
                    if sess.bg_running {
                        let fallback_out = (!streamed_text.trim().is_empty())
                            .then(|| streamed_text.trim().to_string());
                        let err_msg = if final_ok {
                            None
                        } else {
                            Some(
                                captured_stdout_err
                                    .or(captured_stderr_err)
                                    .unwrap_or_else(|| "Antigravity CLI exited with an error.".into()),
                            )
                        };
                        Self::finalize_session_turn(
                            sess,
                            final_ok,
                            fallback_out.as_deref(),
                            err_msg,
                            &now_done,
                        );
                        changed = true;
                    }
                }
            }
            if changed {
                reaper_core.persist();
                reaper_core.broadcast_snapshot(Some(if final_ok { "ready" } else { "denied" }));
            }
        });

        Ok(json!({
            "ok": true,
            "delivery": "headless_agy",
            "pid": pid
        }))
    }

    /// Gracefully terminates all warm persistent `agy.exe` worker processes and background PIDs.
    pub fn shutdown_warm_workers(&self) {
        let mut pids: Vec<u32> = Vec::new();
        {
            let mut g = self.inner.lock().unwrap();
            for (_, w) in g.warm_workers.drain() {
                if !pids.contains(&w.pid) {
                    pids.push(w.pid);
                }
            }
            for (_, p) in g.bg_pids.drain() {
                if !pids.contains(&p) {
                    pids.push(p);
                }
            }
        }
        for pid in pids {
            let _ = kill_owned_child_tree(pid);
        }
    }

    /// Halts an active session via hook termination + pending approval denial + owned headless PID kill.
    pub fn stop_agent_session(&self, conversation_id: &str) -> Result<(), String> {
        let pid_to_kill: Option<u32>;
            let mut approval_ids_to_deny: Vec<String> = Vec::new();
            let mut question_ids_to_cancel: Vec<String> = Vec::new();
            let now_done = chrono::Utc::now().to_rfc3339();

            {
                let mut g = self.inner.lock().unwrap();
                let bg_pid = g.bg_pids.remove(conversation_id);
                let worker_pid = g.warm_workers.remove(conversation_id).map(|w| w.pid);
                let mut extra_pid: Option<u32> = None;

                for p in &g.pending_approvals {
                    if p.conversation_id == conversation_id {
                        approval_ids_to_deny.push(p.id.clone());
                    }
                }
                for q in &g.pending_questions {
                    if q.conversation_id == conversation_id {
                        question_ids_to_cancel.push(q.id.clone());
                    }
                }

            let cli_cid_opt = g
                .sessions
                .iter()
                .find(|s| s.conversation_id == conversation_id)
                .and_then(|s| s.cli_conversation_id.clone());
            if let Some(ref cli_cid) = cli_cid_opt {
                extra_pid = g
                    .bg_pids
                    .remove(cli_cid)
                    .or_else(|| g.warm_workers.remove(cli_cid).map(|w| w.pid));
            }
            pid_to_kill = bg_pid.or(worker_pid).or(extra_pid);

            if let Some(sess) = g
                .sessions
                .iter_mut()
                .find(|s| s.conversation_id == conversation_id)
            {
                sess.stop_requested = true;
                sess.queued_messages.clear();
                sess.mid_process_note = None;
                sess.active_tool = None;
                if pid_to_kill.is_some() || sess.bg_running {
                    Self::finalize_session_turn(sess, true, None, None, &now_done);
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
        for qid in question_ids_to_cancel {
            let _ = self.resolve_question(&qid, Vec::new(), true, false);
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

#[cfg(test)]
mod tests {
    use super::{
        apply_insights_to_session, clean_user_prompt, dedup_and_merge_focus_groups,
        dedup_session_diffs, hook_completion_sound, is_cli_hook_event,
        is_nova_cli_session_origin, AgentProvider, AgentSession,
        FileDiffPreview, FocusGroup, SessionStep, SessionTurn, TranscriptInsights,
    };
    use crate::models::{NormalizedHookEnvelope, ProcessAncestor};
    use serde_json::Value;

    #[test]
    fn app_transcripts_never_enter_cli_lists_even_with_a_stale_cli_link() {
        assert!(!is_nova_cli_session_origin(
            Some(r"C:\Users\dev\.gemini\antigravity\brain\app-id\transcript.jsonl"),
            true,
            "app-id"
        ));
        assert!(is_nova_cli_session_origin(
            Some(r"C:\Users\dev\.gemini\antigravity-cli\brain\cli-id\transcript.jsonl"),
            false,
            "cli-id"
        ));
        assert!(is_nova_cli_session_origin(None, false, "pending-run-1"));
        assert!(!is_nova_cli_session_origin(None, false, "app-id"));
    }

    #[test]
    fn same_workspace_app_hook_cannot_be_mistaken_for_a_pending_cli_hook() {
        let base = NormalizedHookEnvelope {
            agent: "antigravity".into(),
            event: "PreToolUse".into(),
            conversation_id: "app-id".into(),
            workspace_path: r"C:\work\project".into(),
            transcript_path: None,
            git_branch: None,
            model_name: None,
            last_user_input: None,
            tool_call_id: None,
            tool_name: None,
            tool_args: Value::Null,
            command_line: None,
            target_file: None,
            step_idx: None,
            error: None,
            termination_reason: None,
            subagent_role: None,
            process_chain: vec![ProcessAncestor { pid: 10, name: "Antigravity.exe".into() }],
            raw_payload: Value::Null,
        };
        assert!(!is_cli_hook_event(
            &base,
            Some(r"C:\Users\dev\.gemini\antigravity\brain\app-id\transcript.jsonl")
        ));
        assert!(is_cli_hook_event(
            &base,
            Some(r"C:\Users\dev\.gemini\antigravity-cli\brain\cli-id\transcript.jsonl")
        ));
        let cli_process = NormalizedHookEnvelope {
            process_chain: vec![ProcessAncestor { pid: 20, name: "agy.exe".into() }],
            ..base
        };
        assert!(is_cli_hook_event(&cli_process, None));
    }

    #[test]
    fn app_completion_does_not_play_cli_ready_sound() {
        assert_eq!(hook_completion_sound(false), None);
        assert_eq!(hook_completion_sound(true), Some("ready"));
    }

    #[test]
    fn dedup_merges_transcript_and_hook_focus_groups_without_collapsing_distinct_parallel_calls() {
        let mk_step = |id: &str,
                       call_id: Option<&str>,
                       event: &str,
                       verb: &str,
                       summary: &str,
                       range: Option<&str>,
                       status: &str| SessionStep {
            id: id.to_string(),
            call_id: call_id.map(str::to_string),
            step_idx: None,
            event: event.to_string(),
            tool_name: Some(if verb == "Ran" { "run_command" } else { "read_file" }.to_string()),
            summary: summary.to_string(),
            detail: None,
            verb: verb.to_string(),
            file_path: None,
            line_range: range.map(str::to_string),
            start_line: None,
            added_lines: None,
            removed_lines: None,
            unified_diff: None,
            status: status.to_string(),
            timestamp: "2026-11-25T07:51:30Z".to_string(),
        };

        let title = "Inspecting headless agy runner, live NOVA session state, and CLI flags";
        let mut groups = vec![
            FocusGroup {
                id: "fg-1".to_string(),
                title: title.to_string(),
                explicit_focus: true,
                pre_text: None,
                started_at: "2026-11-25T07:51:30Z".to_string(),
                ended_at: Some("2026-11-25T07:52:05Z".to_string()),
                steps: vec![
                    mk_step("tr-0", None, "Transcript", "Analyzed", "state.rs", Some("#L1800-2600"), "done"),
                    mk_step("tr-1", None, "Transcript", "Analyzed", "state.rs", Some("#L2601-3545"), "done"),
                    mk_step("tr-2", None, "Transcript", "Analyzed", "SKILL.md", None, "done"),
                    mk_step("tr-3", None, "Transcript", "Analyzed", "SKILL.md", None, "done"),
                    mk_step("tr-4", None, "Transcript", "Ran", "Inspect live NOVA session snapshot", None, "done"),
                ],
            },
            FocusGroup {
                id: "uuid-fg-2".to_string(),
                title: title.to_string(),
                explicit_focus: true,
                pre_text: None,
                started_at: "2026-11-25T07:52:05Z".to_string(),
                ended_at: None,
                steps: vec![
                    mk_step("hk-0", Some("call_1"), "PreToolUse", "Analyzed", "state.rs", Some("#L1800-2600"), "done"),
                    mk_step("hk-1", Some("call_2"), "PreToolUse", "Analyzed", "state.rs", Some("#L2601-3545"), "done"),
                    mk_step("hk-2", Some("call_3"), "PreToolUse", "Analyzed", "SKILL.md", None, "done"),
                    mk_step("hk-3", Some("call_4"), "PreToolUse", "Analyzed", "SKILL.md", None, "running"),
                    mk_step("hk-4", Some("call_5"), "PreToolUse", "Ran", "Inspect live NOVA session snapshot", None, "running"),
                ],
            },
        ];

        dedup_and_merge_focus_groups(&mut groups);

        assert_eq!(groups.len(), 1, "Duplicate consecutive focus groups must merge into 1");
        assert_eq!(groups[0].started_at, "2026-11-25T07:51:30Z");
        assert_eq!(groups[0].ended_at, None, "Merged active group must stay open");
        assert_eq!(
            groups[0].steps.len(),
            5,
            "All 5 steps (including 2 distinct SKILL.md reads) must be preserved without doubling to 10"
        );
        assert_eq!(groups[0].steps[2].call_id.as_deref(), Some("call_3"));
        assert_eq!(groups[0].steps[3].call_id.as_deref(), Some("call_4"));
        assert_eq!(groups[0].steps[3].status, "running");
    }

    #[test]
    fn dedup_session_diffs_removes_identical_unreverted_hunks() {
        let mut diffs = vec![
            FileDiffPreview {
                file_path: "c:\\Users\\ongch\\Desktop\\NOVA\\src\\App.tsx".into(),
                added_lines: 4,
                removed_lines: 1,
                unified_diff: "@@ -1,2 +1,5 @@\n+const a = 1;".into(),
                timestamp: "2026-11-25T07:52:10Z".into(),
                start_line: Some(1),
                undo_target: None,
                undo_replacement: None,
                reverted: false,
            },
            FileDiffPreview {
                file_path: "C:/Users/ongch/Desktop/NOVA/src/App.tsx".into(),
                added_lines: 4,
                removed_lines: 1,
                unified_diff: "@@ -1,2 +1,5 @@\n+const a = 1;\n".into(),
                timestamp: "2026-11-25T07:52:05Z".into(),
                start_line: Some(1),
                undo_target: None,
                undo_replacement: None,
                reverted: false,
            },
        ];
        dedup_session_diffs(&mut diffs);
        assert_eq!(diffs.len(), 1);
    }

    #[test]
    fn apply_insights_skips_premature_backfill_and_protects_newer_bg_turn() {
        let mut sess = AgentSession {
            conversation_id: "c1".into(),
            agent: "antigravity".into(),
            runtime_provider: Some(AgentProvider::Agy),
            workspace_path: "c:\\repo".into(),
            workspace_name: "repo".into(),
            git_branch: None,
            model_name: None,
            last_user_input: Some("turn 2".into()),
            status: "active".into(),
            phase: "thinking".into(),
            current_focus: None,
            mid_process_note: Some("Warm session — reasoning…".into()),
            latest_thinking: None,
            latest_output: None,
            plan_steps: Vec::new(),
            focus_groups: Vec::new(),
            question_exchanges: Vec::new(),
            artifacts: Vec::new(),
            turns: vec![
                SessionTurn {
                    id: "turn-1".into(),
                    user_prompt: "turn 1".into(),
                    assistant_output: Some("old output".into()),
                    thinking: None,
                    model_name: None,
                    tool_calls_count: 1,
                    files_touched_count: 0,
                    focus_groups: Vec::new(),
                    diffs: Vec::new(),
                    question_exchanges: Vec::new(),
                    artifacts: Vec::new(),
                    started_at: None,
                    completed_at: None,
                    is_active: false,
                },
                SessionTurn {
                    id: "turn-2".into(),
                    user_prompt: "turn 2".into(),
                    assistant_output: None,
                    thinking: None,
                    model_name: None,
                    tool_calls_count: 0,
                    files_touched_count: 0,
                    focus_groups: Vec::new(),
                    diffs: Vec::new(),
                    question_exchanges: Vec::new(),
                    artifacts: Vec::new(),
                    started_at: None,
                    completed_at: None,
                    is_active: true,
                },
            ],
            transcript_path: None,
            queued_messages: Vec::new(),
            stop_requested: false,
            bg_running: true,
            cli_conversation_id: None,
            last_error: None,
            detected_ide_permission: None,
            permission_override: None,
            active_tool: None,
            steps: Vec::new(),
            diffs: Vec::new(),
            subagents: Vec::new(),
            process_chain: Vec::new(),
            started_at: "2026-11-25T07:50:00Z".into(),
            updated_at: "2026-11-25T07:51:00Z".into(),
            commands_count: 0,
            files_touched_count: 0,
        };

        let stale_ins = TranscriptInsights {
            has_explicit_turn: true,
            user_prompt: Some("turn 1".into()),
            latest_output: Some("old output".into()),
            turns: vec![sess.turns[0].clone()],
            ..Default::default()
        };
        assert!(!apply_insights_to_session(&mut sess, stale_ins, true));
        assert_eq!(sess.last_user_input.as_deref(), Some("turn 2"));
        assert_eq!(sess.turns.len(), 2);
        assert!(sess.latest_output.is_none());

        // Same turn, allow_structural_backfill = false must NOT inject transcript focus_groups
        sess.bg_running = false;
        let same_turn_ins = TranscriptInsights {
            has_explicit_turn: true,
            user_prompt: Some("turn 2".into()),
            focus_groups: vec![FocusGroup {
                id: "fg-1".into(),
                title: "Reading files".into(),
                explicit_focus: true,
                pre_text: None,
                started_at: "2026-11-25T07:51:01Z".into(),
                ended_at: None,
                steps: Vec::new(),
            }],
            turns: sess.turns.clone(),
            ..Default::default()
        };
        let _ = apply_insights_to_session(&mut sess, same_turn_ins, false);
        assert!(
            sess.focus_groups.is_empty(),
            "Backfill must stay disabled while hooks manage live focus_groups"
        );
    }

    #[test]
    fn clean_user_prompt_preserves_multiline_formatting_and_full_length() {
        let long_body = format!(
            "<USER_REQUEST>\nFix the following UI issues:\n1. Make prompt expandable\n2. Preserve code indentation:\n```ts\nconst x = () => {{\n  return {};\n}};\n```\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nuploaded 1 image(s):\n</ADDITIONAL_METADATA>",
            "a".repeat(600)
        );
        let cleaned = clean_user_prompt(&long_body).expect("should clean prompt");
        assert!(cleaned.contains("1. Make prompt expandable\n2. Preserve code indentation:"));
        assert!(cleaned.contains("  return aaaaa"));
        assert!(cleaned.len() > 600, "full prompt must not be truncated at 240 chars");
        assert!(!cleaned.contains("ADDITIONAL_METADATA"));

        let spaced_paragraphs = "<USER_REQUEST>\nhey i let gpt do thing\n\nbecaseu of compact space\n\n\nget it\n</USER_REQUEST>";
        assert_eq!(
            clean_user_prompt(spaced_paragraphs).as_deref(),
            Some("hey i let gpt do thing\n\nbecaseu of compact space\n\n\nget it"),
            "must preserve exact blank lines and paragraph spacing typed by the user"
        );
    }

    #[test]
    fn clean_user_prompt_strips_legacy_and_tagged_handoff_context() {
        let legacy = "<USER_REQUEST>[Context from preceding Antigravity IDE session in workspace `NOVA`:\nLast user request: start git init here remote url https://github.com/0NGKUNG/NOVA.git\nLast assistant summary: Git is initialized in `C:\\Users\\ongch\\Desktop\\NOVA`, connected [README.md](file:///C:/README.md).]\n\nexpand able to see full promt\ncorrect the promt format</USER_REQUEST>";
        assert_eq!(
            clean_user_prompt(legacy).as_deref(),
            Some("expand able to see full promt\ncorrect the promt format")
        );

        let tagged = "<USER_REQUEST><NOVA_HANDOFF_CONTEXT>\nWorkspace: `NOVA`\nLast user request: init\nLast assistant summary: done\n</NOVA_HANDOFF_CONTEXT>\n\nPlease run tests and verify build</USER_REQUEST>";
        assert_eq!(
            clean_user_prompt(tagged).as_deref(),
            Some("Please run tests and verify build")
        );
    }

    #[test]
    fn clean_user_prompt_formats_screenshot_attachment_cleanly() {
        let with_snip = "Check alignment on top bar\n\n[Attached Screenshot: `C:\\Users\\ongch\\AppData\\Local\\Temp\\nova-snip-123.png` — inspect this image file with read_file]";
        assert_eq!(
            clean_user_prompt(with_snip).as_deref(),
            Some("Check alignment on top bar\n\n📎 Attached screenshot: `nova-snip-123.png`")
        );

        let with_multi = "Compare these two designs\n\n[Attached Images — inspect each image file with read_file:\n- `C:\\Users\\ongch\\AppData\\Local\\NOVA\\snips\\mockup-1.png`\n- `C:\\Users\\ongch\\AppData\\Local\\NOVA\\snips\\photo-2.jpg`]";
        assert_eq!(
            clean_user_prompt(with_multi).as_deref(),
            Some("Compare these two designs\n\n📎 Attached images: `mockup-1.png`, `photo-2.jpg`")
        );
    }

    #[test]
    fn extract_questions_and_artifacts_support_protojson_and_live_hook_shapes() {
        use super::{
            extract_artifact_metadata, extract_question_items, parse_question_result_answers,
        };
        use serde_json::json;

        // 1. Stringified protojson `questions` from `transcript.jsonl`
        let tr_args = json!({
            "questions": "[{\"options\":[\"(Recommended) Aura Waveform Bars\",\"Cosmic NOVA Star\"],\"question\":\"Which right-side indicator fits NOVA's theme best?\"},{\"options\":[\"Apple Blur-Glide\",\"Crisp Slot Flip\"],\"is_multi_select\":true,\"question\":\"Which text-appear animation do you want?\"}]"
        });
        let qs = extract_question_items(&tr_args).expect("should parse transcript questions");
        assert_eq!(qs.len(), 2);
        assert_eq!(qs[0].question, "Which right-side indicator fits NOVA's theme best?");
        assert_eq!(qs[0].options.len(), 2);
        assert!(!qs[0].is_multi_select);
        assert!(qs[1].is_multi_select);

        // 2. Direct JSON array `questions` from `PreToolUse` hook
        let hook_args = json!({
            "questions": [
                {
                    "question": "Pick deployment target",
                    "options": ["Vercel", "Cloudflare"],
                    "is_multi_select": false
                }
            ]
        });
        let hqs = extract_question_items(&hook_args).expect("should parse hook questions");
        assert_eq!(hqs.len(), 1);
        assert_eq!(hqs[0].options, vec!["Vercel", "Cloudflare"]);

        // 3. Parse `A1:` / `A2:` tool result
        let tool_res = "Created At: 2026-11-27T12:01:26+07:00\nCompleted At: 2026-11-27T12:05:36+07:00\nA1: (Recommended) Aura Waveform Bars\nA2: Apple Blur-Glide";
        let (answers, skipped) = parse_question_result_answers(tool_res, 2);
        assert!(!skipped);
        assert_eq!(answers, vec!["(Recommended) Aura Waveform Bars", "Apple Blur-Glide"]);

        // 4. Extract `ArtifactMetadata` from `write_file`
        let art_args = json!({
            "Path": "C:\\Users\\ongch\\.gemini\\antigravity\\brain\\abc\\implementation_plan.md",
            "ArtifactMetadata": "{\"RequestFeedback\":true,\"Summary\":\"Implementation plan for ask_question support\",\"UserFacing\":true}"
        });
        let art = extract_artifact_metadata("write_file", &art_args, None, "2026-11-27T05:10:00Z")
            .expect("should extract artifact metadata");
        assert_eq!(art.file_name, "implementation_plan.md");
        assert!(art.request_feedback);
        assert!(art.user_facing);
        assert_eq!(art.summary, "Implementation plan for ask_question support");
    }

    #[test]
    fn embed_runtime_normalizes_file_uris_and_injects_theme_and_resize_bridge() {
        use super::{inject_nova_embed_runtime, normalize_embed_file_path};

        assert_eq!(
            normalize_embed_file_path(
                "file:///C:/Users/ongch/.gemini/antigravity-cli/brain/123/my%20widget.html#top"
            ),
            "C:/Users/ongch/.gemini/antigravity-cli/brain/123/my widget.html"
        );
        assert_eq!(
            normalize_embed_file_path("file:///home/dev/.gemini/antigravity/brain/1/demo.html"),
            "/home/dev/.gemini/antigravity/brain/1/demo.html"
        );

        let raw = "<!DOCTYPE html><html><head><title>Demo</title></head><body class=\"bg-transparent\"><div>Hello</div></body></html>";
        let out = inject_nova_embed_runtime(raw, "nova-emb-42", true);
        assert!(out.contains("id=\"nova-agent-embed-vars\""));
        assert!(out.contains("--card:"));
        assert!(out.contains("--foreground:"));
        assert!(out.contains("nova-agent-embed-resize"));
        assert!(out.contains("\"nova-emb-42\""));
        let style_idx = out.find("nova-agent-embed-vars").unwrap();
        let title_idx = out.find("<title>Demo</title>").unwrap();
        let script_idx = out.find("nova-agent-embed-bridge").unwrap();
        let body_end_idx = out.rfind("</body>").unwrap();
        assert!(style_idx < title_idx, "theme defaults must precede widget head tags");
        assert!(script_idx < body_end_idx, "resize bridge must precede </body>");
    }
}
