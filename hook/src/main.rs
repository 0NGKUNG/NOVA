//! NOVA Hook Relay (`nova-hook.exe`)
//!
//! Invoked synchronously by Antigravity (`~/.gemini/config/hooks.json`) and other
//! AI coding agents. Strict safety contract:
//! - Connect timeout to NOVA Core (`127.0.0.1:47920`) is 250 ms.
//! - If NOVA is closed, busy, or unreachable, immediately outputs the agent's
//!   safe non-blocking fallback (`{"decision":"ask"}` for PreToolUse, `{}` otherwise)
//!   and exits 0 so the coding agent is NEVER stalled.
//! - Walks the Windows process tree (`CreateToolhelp32Snapshot`) to attach the
//!   parent terminal / IDE PID chain so NOVA's "Jump to Workspace / Terminal"
//!   focuses the exact window running the session.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::env;
use std::fs;
use std::io::{self, Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::time::Duration;

const DEFAULT_PORT: u16 = 47920;

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
    pub raw_payload: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct HookRelayResponse {
    pub decision: Option<String>,
    pub reason: Option<String>,
    pub permission_overrides: Option<Vec<String>>,
    pub overwrite: Option<Value>,
    pub inject_system_message: Option<String>,
    pub inject_user_message: Option<String>,
    pub inject_error_message: Option<String>,
    pub termination_behavior: Option<String>,
}

fn fail_open_stdout(agent: &str, event: &str) -> String {
    let ev_lower = event.to_ascii_lowercase();
    if ev_lower == "pretooluse" || ev_lower == "beforetool" {
        if agent.eq_ignore_ascii_case("antigravity") || agent.eq_ignore_ascii_case("copilot") {
            return json!({ "decision": "ask" }).to_string();
        }
    }
    "{}".to_string()
}

fn ipc_token_and_port() -> (String, u16) {
    let port = env::var("NOVA_IPC_PORT")
        .ok()
        .and_then(|v| v.parse::<u16>().ok())
        .unwrap_or(DEFAULT_PORT);

    let mut base = env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .or_else(|| env::var_os("USERPROFILE").map(|p| PathBuf::from(p).join("AppData\\Local")))
        .unwrap_or_else(env::temp_dir);
    base.push("NOVA");
    base.push("ipc.token");
    let token = fs::read_to_string(base)
        .map(|s| s.trim().to_string())
        .unwrap_or_default();
    (token, port)
}

fn detect_git_branch(workspace: &str) -> Option<String> {
    if workspace.is_empty() {
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

#[cfg(windows)]
fn collect_process_chain() -> Vec<ProcessAncestor> {
    use std::collections::HashMap;
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };

    let mut table: HashMap<u32, (u32, String)> = HashMap::new();
    unsafe {
        let snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snap == INVALID_HANDLE_VALUE {
            return Vec::new();
        }
        let mut entry: PROCESSENTRY32W = std::mem::zeroed();
        entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
        if Process32FirstW(snap, &mut entry) != 0 {
            loop {
                let len = entry
                    .szExeFile
                    .iter()
                    .position(|&c| c == 0)
                    .unwrap_or(entry.szExeFile.len());
                let exe = String::from_utf16_lossy(&entry.szExeFile[..len]);
                table.insert(entry.th32ProcessID, (entry.th32ParentProcessID, exe));
                if Process32NextW(snap, &mut entry) == 0 {
                    break;
                }
            }
        }
        CloseHandle(snap);
    }

    let mut chain = Vec::new();
    let mut pid = std::process::id();
    for _ in 0..14 {
        if let Some((ppid, name)) = table.get(&pid) {
            chain.push(ProcessAncestor {
                pid,
                name: name.clone(),
            });
            if *ppid == 0 || *ppid == pid {
                break;
            }
            pid = *ppid;
        } else {
            break;
        }
    }
    chain
}

#[cfg(not(windows))]
fn collect_process_chain() -> Vec<ProcessAncestor> {
    vec![ProcessAncestor {
        pid: std::process::id(),
        name: "nova-hook".to_string(),
    }]
}

fn str_field(v: &Value, keys: &[&str]) -> Option<String> {
    for k in keys {
        if let Some(s) = v.get(*k).and_then(|x| x.as_str()) {
            if !s.is_empty() {
                return Some(s.to_string());
            }
        }
    }
    None
}

fn normalize_payload(agent: &str, cli_event: Option<&str>, payload: Value) -> NormalizedHookEnvelope {
    let event = cli_event
        .map(|s| s.to_string())
        .or_else(|| str_field(&payload, &["hookEventName", "hook_event_name", "event"]))
        .unwrap_or_else(|| "PostToolUse".to_string());

    let workspace_path = payload
        .get("workspacePaths")
        .and_then(|w| w.as_array())
        .and_then(|arr| arr.first())
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .or_else(|| str_field(&payload, &["cwd", "workspace_path", "projectDir"]))
        .unwrap_or_else(|| {
            env::current_dir()
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_default()
        });

    let conversation_id = str_field(
        &payload,
        &["conversationId", "session_id", "sessionId", "threadId"],
    )
    .unwrap_or_else(|| format!("session-{}", &workspace_path));

    let tool_obj = payload
        .get("toolCall")
        .or_else(|| payload.get("tool_call"))
        .cloned()
        .unwrap_or(Value::Null);

    let tool_call_id = str_field(&tool_obj, &["id", "tool_use_id"])
        .or_else(|| str_field(&payload, &["tool_use_id", "toolCallId"]));

    let tool_name = str_field(&tool_obj, &["name", "tool_name"])
        .or_else(|| str_field(&payload, &["tool_name", "toolName"]));

    let tool_args = tool_obj
        .get("args")
        .or_else(|| tool_obj.get("input"))
        .or_else(|| payload.get("tool_input"))
        .cloned()
        .unwrap_or_else(|| json!({}));

    let command_line = str_field(&tool_args, &["CommandLine", "command", "cmd", "script"]);
    let target_file = str_field(
        &tool_args,
        &["Path", "TargetFile", "file_path", "path", "AbsolutePath"],
    );

    let subagent_role = if matches!(
        tool_name.as_deref(),
        Some("invoke_subagent") | Some("swarm") | Some("Task")
    ) {
        str_field(&tool_args, &["Role", "name", "TypeName", "description"])
    } else {
        None
    };

    let step_idx = payload
        .get("stepIdx")
        .or_else(|| payload.get("invocationNum"))
        .and_then(|v| v.as_u64());

    let git_branch = detect_git_branch(&workspace_path);

    let transcript_path = str_field(&payload, &["transcriptPath", "transcript_path"]);

    NormalizedHookEnvelope {
        agent: agent.to_string(),
        event,
        conversation_id,
        workspace_path,
        transcript_path,
        git_branch,
        model_name: str_field(&payload, &["modelName", "model"]),
        last_user_input: str_field(&payload, &["lastUserInput", "prompt"]),
        tool_call_id,
        tool_name,
        tool_args,
        command_line,
        target_file,
        step_idx,
        error: str_field(&payload, &["error"]),
        termination_reason: str_field(&payload, &["terminationReason", "reason"]),
        subagent_role,
        process_chain: collect_process_chain(),
        raw_payload: payload,
    }
}

fn post_to_nova(envelope: &NormalizedHookEnvelope) -> Option<HookRelayResponse> {
    let (token, port) = ipc_token_and_port();
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let stream = TcpStream::connect_timeout(&addr, Duration::from_millis(250)).ok()?;

    let is_blocking_approval = envelope.event.eq_ignore_ascii_case("PreToolUse")
        || envelope.event.eq_ignore_ascii_case("BeforeTool");

    let read_timeout = if is_blocking_approval {
        Duration::from_secs(290)
    } else {
        Duration::from_millis(900)
    };
    let _ = stream.set_write_timeout(Some(Duration::from_millis(500)));
    let _ = stream.set_read_timeout(Some(read_timeout));

    let body = serde_json::to_vec(envelope).ok()?;
    let request = format!(
        "POST /api/hook HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nContent-Type: application/json\r\nX-Nova-Token: {token}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );

    let mut stream = stream;
    stream.write_all(request.as_bytes()).ok()?;
    stream.write_all(&body).ok()?;
    stream.flush().ok()?;

    let mut raw_resp = Vec::new();
    stream.read_to_end(&mut raw_resp).ok()?;
    let resp_str = String::from_utf8_lossy(&raw_resp);
    let (_, json_body) = resp_str.split_once("\r\n\r\n")?;
    serde_json::from_str::<HookRelayResponse>(json_body.trim()).ok()
}

fn format_agent_output(agent: &str, event: &str, reply: HookRelayResponse) -> String {
    let ev_lower = event.to_ascii_lowercase();
    if ev_lower == "pretooluse" || ev_lower == "beforetool" {
        let decision = reply.decision.unwrap_or_else(|| "ask".to_string());
        if agent.eq_ignore_ascii_case("antigravity") {
            let mut out = json!({ "decision": decision });
            if let Some(reason) = reply.reason {
                if !reason.is_empty() {
                    out["reason"] = Value::String(reason);
                }
            }
            if let Some(overrides) = reply.permission_overrides {
                if !overrides.is_empty() {
                    out["permissionOverrides"] = json!(overrides);
                }
            }
            if let Some(ov) = reply.overwrite {
                if ov.is_object() {
                    out["overwrite"] = ov;
                }
            }
            return out.to_string();
        }
        // Claude Code / generic hook output
        if decision == "allow" {
            return json!({
                "hookSpecificOutput": {
                    "hookEventName": "PreToolUse",
                    "permissionDecision": "allow"
                }
            })
            .to_string();
        } else if decision == "deny" {
            return json!({
                "hookSpecificOutput": {
                    "hookEventName": "PreToolUse",
                    "permissionDecision": "deny",
                    "permissionDecisionReason": reply.reason.unwrap_or_else(|| "Denied from NOVA".to_string())
                }
            })
            .to_string();
        }
        return "{}".to_string();
    }

    if ev_lower == "stop" {
        if agent.eq_ignore_ascii_case("antigravity")
            && reply.decision.as_deref() == Some("continue")
        {
            let mut out = json!({ "decision": "continue" });
            if let Some(reason) = reply.reason {
                if !reason.is_empty() {
                    out["reason"] = Value::String(reason);
                }
            }
            return out.to_string();
        }
        return "{}".to_string();
    }

    if agent.eq_ignore_ascii_case("antigravity")
        && matches!(
            ev_lower.as_str(),
            "preinvocation" | "postinvocation" | "sessionstart"
        )
    {
        let mut inject_steps: Vec<Value> = Vec::new();
        if let Some(user_msg) = reply.inject_user_message {
            if !user_msg.trim().is_empty() {
                inject_steps.push(json!({ "userMessage": user_msg }));
            }
        }
        if let Some(sys_msg) = reply.inject_system_message {
            if !sys_msg.trim().is_empty() {
                inject_steps.push(json!({
                    "systemMessage": { "systemMessage": sys_msg }
                }));
            }
        }
        if let Some(err_msg) = reply.inject_error_message {
            if !err_msg.trim().is_empty() {
                inject_steps.push(json!({
                    "errorMessage": { "userMessage": err_msg }
                }));
            }
        }

        let mut out = serde_json::Map::new();
        if !inject_steps.is_empty() {
            out.insert("injectSteps".to_string(), Value::Array(inject_steps));
        }
        if let Some(tb) = reply.termination_behavior {
            if !tb.trim().is_empty() {
                out.insert("terminationBehavior".to_string(), Value::String(tb));
            }
        }
        if !out.is_empty() {
            return Value::Object(out).to_string();
        }
    }

    "{}".to_string()
}

fn main() {
    let args: Vec<String> = env::args().skip(1).collect();
    let mut agent = "antigravity".to_string();
    let mut cli_event: Option<String> = None;

    let mut idx = 0;
    while idx < args.len() {
        match args[idx].as_str() {
            "--version" | "-V" => {
                println!("nova-hook {}", env!("CARGO_PKG_VERSION"));
                return;
            }
            "--agent" => {
                if let Some(val) = args.get(idx + 1) {
                    agent = val.clone();
                    idx += 2;
                    continue;
                }
            }
            other if !other.starts_with('-') => {
                cli_event = Some(other.to_string());
            }
            _ => {}
        }
        idx += 1;
    }

    let mut stdin_buf = String::new();
    let _ = io::stdin().read_to_string(&mut stdin_buf);
    let parsed_json = if stdin_buf.trim().is_empty() {
        json!({})
    } else {
        serde_json::from_str::<Value>(&stdin_buf).unwrap_or_else(|_| json!({}))
    };

    let envelope = normalize_payload(&agent, cli_event.as_deref(), parsed_json);
    let event_name = envelope.event.clone();

    let output = match post_to_nova(&envelope) {
        Some(reply) => format_agent_output(&agent, &event_name, reply),
        None => fail_open_stdout(&agent, &event_name),
    };

    println!("{output}");
}
