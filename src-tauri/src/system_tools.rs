use crate::agy_hooks::nova_data_dir;
use crate::models::{
    GpuTelemetry, HardwareTelemetry, MediaStatus, PortProcessInfo, ProcessAncestor, ShortcutBinding,
    TopProcessInfo, WorkspaceEntry,
};
use base64::Engine;
use std::collections::{BTreeMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use sysinfo::{Pid, ProcessesToUpdate, System};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

fn silent_cmd(program: &str) -> Command {
    let mut cmd = Command::new(program);
    #[cfg(windows)]
    {
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

/// Samples live CPU, RAM, Top Processes, Fullscreen Foreground status, and optional NVIDIA GPU telemetry.
pub fn sample_hardware_telemetry(sys: &mut System) -> HardwareTelemetry {
    sys.refresh_cpu_usage();
    sys.refresh_memory();
    sys.refresh_processes(ProcessesToUpdate::All, true);

    let cpu_percent = sys.global_cpu_usage();
    let cpu_brand = sys
        .cpus()
        .first()
        .map(|c| c.brand().trim().to_string())
        .unwrap_or_else(|| "x86_64 Processor".to_string());
    let core_count = sys.cpus().len();

    let total_mem = sys.total_memory() as f64;
    let used_mem = sys.used_memory() as f64;
    let ram_total_gb = (total_mem / 1_073_741_824.0) as f32;
    let ram_used_gb = (used_mem / 1_073_741_824.0) as f32;
    let ram_percent = if total_mem > 0.0 {
        ((used_mem / total_mem) * 100.0) as f32
    } else {
        0.0
    };

    let mut procs: Vec<TopProcessInfo> = sys
        .processes()
        .iter()
        .map(|(pid, p)| TopProcessInfo {
            pid: pid.as_u32(),
            name: p.name().to_string_lossy().to_string(),
            cpu_percent: p.cpu_usage() / (core_count.max(1) as f32),
            memory_mb: p.memory() / (1024 * 1024),
        })
        .filter(|p| p.memory_mb >= 25)
        .collect();

    procs.sort_by(|a, b| {
        b.memory_mb
            .cmp(&a.memory_mb)
            .then_with(|| b.cpu_percent.partial_cmp(&a.cpu_percent).unwrap_or(std::cmp::Ordering::Equal))
    });
    procs.truncate(8);

    HardwareTelemetry {
        cpu_percent,
        cpu_brand,
        core_count,
        ram_used_gb,
        ram_total_gb,
        ram_percent,
        gpu: query_nvidia_gpu(),
        top_processes: procs,
        fullscreen_active: is_foreground_fullscreen(),
    }
}

fn query_nvidia_gpu() -> Option<GpuTelemetry> {
    let output = silent_cmd("nvidia-smi")
        .args([
            "--query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu",
            "--format=csv,noheader,nounits",
        ])
        .output()
        .ok()?;

    if !output.status.success() {
        return None;
    }
    let line = String::from_utf8_lossy(&output.stdout);
    let first = line.lines().next()?.trim();
    let cols: Vec<&str> = first.split(',').map(|s| s.trim()).collect();
    if cols.len() < 4 {
        return None;
    }
    Some(GpuTelemetry {
        name: cols[0].to_string(),
        load_percent: cols[1].parse::<f32>().unwrap_or(0.0),
        vram_used_mb: cols[2].parse::<u64>().unwrap_or(0),
        vram_total_mb: cols[3].parse::<u64>().unwrap_or(0),
        temp_c: cols.get(4).and_then(|t| t.parse::<u32>().ok()),
    })
}

/// Lists active TCP listening ports on this Windows machine, enriched with process names and dev framework hints.
pub fn scan_listening_ports(sys: &mut System) -> Vec<PortProcessInfo> {
    sys.refresh_processes(ProcessesToUpdate::All, false);
    let output = match silent_cmd("netstat").args(["-ano", "-p", "tcp"]).output() {
        Ok(o) => o,
        Err(_) => return Vec::new(),
    };
    let text = String::from_utf8_lossy(&output.stdout);
    let mut by_port: BTreeMap<u16, PortProcessInfo> = BTreeMap::new();

    for line in text.lines() {
        let trimmed = line.trim();
        if !trimmed.starts_with("TCP") {
            continue;
        }
        let cols: Vec<&str> = trimmed.split_whitespace().collect();
        if cols.len() < 5 || !cols[3].eq_ignore_ascii_case("LISTENING") {
            continue;
        }
        let local_addr = cols[1];
        let pid = match cols[4].parse::<u32>() {
            Ok(p) if p > 4 => p,
            _ => continue,
        };
        let Some((_, port_str)) = local_addr.rsplit_once(':') else {
            continue;
        };
        let Ok(port) = port_str.parse::<u16>() else {
            continue;
        };

        // Filter out ephemeral Windows RPC high ports unless owned by a known dev runtime
        let proc_name = sys
            .process(Pid::from_u32(pid))
            .map(|p| p.name().to_string_lossy().to_string())
            .unwrap_or_else(|| format!("PID {pid}"));

        let lower_proc = proc_name.to_ascii_lowercase();
        let is_dev_runtime = [
            "node", "bun", "deno", "python", "cargo", "nova", "vite", "next", "go", "java",
            "dotnet", "postgres", "redis", "docker", "nginx", "caddy", "ruby", "php",
        ]
        .iter()
        .any(|k| lower_proc.contains(k));

        if port >= 49152 && !is_dev_runtime {
            continue;
        }
        if matches!(port, 135 | 445 | 5040 | 7680) && !is_dev_runtime {
            continue;
        }

        let framework_hint = match port {
            1420 => Some("Vite / Tauri Dev".into()),
            3000..=3010 => Some("Next.js / React / Node".into()),
            4000 | 4200 | 4321 => Some("Astro / Angular / GraphQL".into()),
            5000 | 5173..=5179 => Some("Vite Dev Server".into()),
            5432 => Some("PostgreSQL".into()),
            6379 => Some("Redis".into()),
            8000 | 8080 | 8888 => Some("HTTP / FastAPI / Backend".into()),
            11434 => Some("Ollama Local LLM".into()),
            1234 => Some("LM Studio Local LLM".into()),
            47920 => Some("NOVA Core Engine".into()),
            _ if lower_proc.contains("node") => Some("Node.js Server".into()),
            _ if lower_proc.contains("python") => Some("Python Server".into()),
            _ => None,
        };

        by_port.entry(port).or_insert(PortProcessInfo {
            port,
            proto: "TCP".into(),
            local_address: local_addr.to_string(),
            pid,
            process_name: proc_name,
            framework_hint,
        });
    }

    by_port.into_values().collect()
}

const PROTECTED_PROCESS_NAMES: &[&str] = &[
    "system",
    "idle",
    "registry",
    "smss.exe",
    "csrss.exe",
    "wininit.exe",
    "services.exe",
    "lsass.exe",
    "lsm.exe",
    "svchost.exe",
    "winlogon.exe",
    "dwm.exe",
    "explorer.exe",
    "sihost.exe",
    "taskhostw.exe",
    "fontdrvhost.exe",
    "spoolsv.exe",
    "searchindexer.exe",
    "msmpeng.exe",
    "securityhealthservice.exe",
    "antigravity.exe",
    "code.exe",
];

pub fn kill_process_by_pid(sys: &mut System, pid: u32) -> Result<String, String> {
    if pid <= 4 || pid == std::process::id() {
        return Err("Refusing to terminate protected or NOVA process".to_string());
    }

    let listening_ports = scan_listening_ports(sys);
    let Some(port_entry) = listening_ports.iter().find(|p| p.pid == pid && p.port != 47920) else {
        return Err(
            "Refusing to terminate PID: process does not own an active user dev port".to_string(),
        );
    };

    let proc_lower = port_entry.process_name.to_ascii_lowercase();
    if PROTECTED_PROCESS_NAMES.iter().any(|&p| proc_lower == p) {
        return Err(format!(
            "Refusing to terminate protected system/IDE process: {}",
            port_entry.process_name
        ));
    }

    let out = silent_cmd("taskkill")
        .args(["/PID", &pid.to_string(), "/F"])
        .output()
        .map_err(|e| format!("Failed to invoke taskkill: {e}"))?;
    if out.status.success() {
        Ok(format!(
            "Terminated {} (PID {pid}, port :{})",
            port_entry.process_name, port_entry.port
        ))
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

/// Safely opens strictly validated http:// or https:// URLs without invoking cmd.exe shell parsing.
pub fn open_url_or_path(target: &str) -> Result<(), String> {
    let trimmed = target.trim();
    let lower = trimmed.to_ascii_lowercase();
    if !(lower.starts_with("https://") || lower.starts_with("http://")) {
        return Err("Only http:// and https:// URLs are permitted".to_string());
    }
    if trimmed.len() > 2048
        || trimmed
            .chars()
            .any(|c| c.is_control() || matches!(c, ' ' | '"' | '\'' | '`' | '\r' | '\n'))
    {
        return Err("Rejected malformed or unsafe URL characters".to_string());
    }

    #[cfg(windows)]
    {
        silent_cmd("rundll32.exe")
            .args(["url.dll,FileProtocolHandler", trimmed])
            .spawn()
            .map_err(|e| format!("Failed to open URL: {e}"))?;
        return Ok(());
    }
    #[cfg(not(windows))]
    {
        Ok(())
    }
}

pub fn open_in_editor(
    file_path: &str,
    line: Option<u32>,
    preferred_editor: Option<&str>,
) -> Result<String, String> {
    let trimmed = file_path.trim();
    if trimmed.is_empty() || trimmed.chars().any(|c| c.is_control()) {
        return Err("Invalid editor target path".to_string());
    }
    let path_obj = Path::new(trimmed);
    if !path_obj.exists() {
        return Err("Target file or workspace path does not exist".to_string());
    }

    let goto_target = match line {
        Some(l) if path_obj.is_file() => format!("{trimmed}:{l}"),
        _ => trimmed.to_string(),
    };

    if preferred_editor.unwrap_or("antigravity") == "antigravity" {
        if let Some(local) = std::env::var_os("LOCALAPPDATA") {
            let ide_cmd = PathBuf::from(local)
                .join("Programs")
                .join("Antigravity IDE")
                .join("bin")
                .join("antigravity-ide.cmd");
            if ide_cmd.is_file() {
                let prog = ide_cmd.to_string_lossy().to_string();
                let args: Vec<&str> = if path_obj.is_file() {
                    vec!["--reuse-window", "--goto", &goto_target]
                } else {
                    vec!["--reuse-window", trimmed]
                };
                if silent_cmd(&prog).args(&args).spawn().is_ok() {
                    return Ok(format!("Opened {goto_target} in Antigravity IDE"));
                }
            }
        }
    }

    let candidates: Vec<&str> = match preferred_editor {
        Some("antigravity") => vec![
            "antigravity-ide.cmd",
            "antigravity.cmd",
            "antigravity",
            "code.cmd",
            "code",
        ],
        Some("cursor") => vec!["cursor.cmd", "cursor", "code.cmd"],
        _ => vec![
            "antigravity-ide.cmd",
            "antigravity.cmd",
            "code.cmd",
            "cursor.cmd",
            "code",
        ],
    };

    for bin in candidates {
        let args: Vec<&str> = if path_obj.is_file() {
            vec!["--reuse-window", "--goto", &goto_target]
        } else {
            vec!["--reuse-window", trimmed]
        };
        if silent_cmd(bin).args(&args).spawn().is_ok() {
            return Ok(format!("Opened {goto_target} via {bin}"));
        }
    }

    Err("No supported code editor CLI (Antigravity IDE, VS Code, Cursor) found".to_string())
}

/// Resolves the installed headless Antigravity CLI (`agy.exe`) path on Windows.
pub fn resolve_agy_cli_path() -> Option<PathBuf> {
    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        let p = PathBuf::from(local).join("agy").join("bin").join("agy.exe");
        if p.is_file() {
            return Some(p);
        }
    }
    if let Some(home) = std::env::var_os("USERPROFILE") {
        let p = PathBuf::from(home)
            .join("AppData")
            .join("Local")
            .join("agy")
            .join("bin")
            .join("agy.exe");
        if p.is_file() {
            return Some(p);
        }
    }
    if let Ok(out) = silent_cmd("where.exe").arg("agy.exe").output() {
        if out.status.success() {
            if let Some(first) = String::from_utf8_lossy(&out.stdout).lines().next() {
                let pb = PathBuf::from(first.trim());
                if pb.is_file() {
                    return Some(pb);
                }
            }
        }
    }
    None
}

/// Spawns `agy.exe` silently (`CREATE_NO_WINDOW`) in `--output-format stream-json` mode with piped stdout/stderr.
pub fn spawn_headless_agy_turn(
    agy_exe: &Path,
    workspace_dir: &Path,
    conversation_id: Option<&str>,
    prompt: &str,
    mode: &str,
    effort: Option<&str>,
    skip_permissions: bool,
) -> Result<std::process::Child, String> {
    let mut cmd = silent_cmd(&agy_exe.to_string_lossy());
    cmd.current_dir(workspace_dir)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    if let Some(cid) = conversation_id.map(str::trim).filter(|s| {
        !s.is_empty()
            && !s.starts_with("pending-")
            && !s.starts_with("session-")
            && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
    }) {
        cmd.args(["--conversation", cid]);
    }

    // Only pass explicit non-default modes (`--mode auto` emits an unsupported warning on some accounts)
    if matches!(mode, "accept-edits" | "plan") {
        cmd.args(["--mode", mode]);
    }

    if let Some(eff) = effort.map(str::trim).filter(|e| {
        matches!(*e, "low" | "medium" | "high" | "xhigh" | "max")
    }) {
        cmd.args(["--effort", eff]);
    }

    if skip_permissions {
        cmd.arg("--dangerously-skip-permissions");
    }

    cmd.args(["--output-format", "stream-json", "-p", prompt]);
    cmd.spawn()
        .map_err(|e| format!("Failed to start headless agy.exe: {e}"))
}

fn map_antigravity_policy_str(raw: &str) -> Option<&'static str> {
    let up = raw.trim().to_ascii_uppercase();
    if up.is_empty() {
        return None;
    }
    if up.contains("TURBO") || up.contains("EAGER") || up.contains("ALWAYS_PROCEED") || up == "ALWAYS-PROCEED" {
        return Some("Turbo");
    }
    if up.contains("REVIEW") || up.contains("OFF") || up.contains("NEVER") || up.contains("ASK") {
        return Some("Review");
    }
    if up.contains("AUTO") || up.contains("MEDIUM") || up.contains("DEFAULT") || up.contains("SMART") {
        return Some("Auto");
    }
    None
}

fn normalize_ws_for_compare(raw: &str) -> String {
    let decoded = raw
        .trim()
        .replace("%3A", ":")
        .replace("%3a", ":")
        .replace("%20", " ");
    let stripped = decoded
        .strip_prefix("file:///")
        .or_else(|| decoded.strip_prefix("file://"))
        .unwrap_or(&decoded);
    stripped
        .replace('/', "\\")
        .trim_start_matches('\\')
        .trim_end_matches('\\')
        .to_ascii_lowercase()
}

/// Reads Antigravity IDE's live global & per-project permission preset (`Turbo` / `Auto` / `Review`)
/// directly from `~/.gemini/config/config.json` and `~/.gemini/config/projects/*.json`.
pub fn detect_antigravity_permission_mode(workspace_path: Option<&str>) -> Option<String> {
    let home = std::env::var_os("USERPROFILE").map(PathBuf::from)?;
    let config_dir = home.join(".gemini").join("config");

    // 1. Check per-project override first if workspace_path matches a configured project
    if let Some(ws) = workspace_path.map(str::trim).filter(|s| !s.is_empty()) {
        let target_norm = normalize_ws_for_compare(ws);
        let projects_dir = config_dir.join("projects");
        if let Ok(entries) = std::fs::read_dir(&projects_dir) {
            for entry in entries.flatten() {
                let p = entry.path();
                if p.extension().and_then(|e| e.to_str()) != Some("json") {
                    continue;
                }
                let Ok(raw) = std::fs::read_to_string(&p) else {
                    continue;
                };
                let Ok(v) = serde_json::from_str::<serde_json::Value>(&raw) else {
                    continue;
                };
                let matches_ws = v
                    .pointer("/projectResources/resources")
                    .and_then(|r| r.as_array())
                    .is_some_and(|arr| {
                        arr.iter().any(|item| {
                            item.pointer("/gitFolder/folderUri")
                                .or_else(|| item.pointer("/folder/folderUri"))
                                .or_else(|| item.get("folderUri"))
                                .and_then(|u| u.as_str())
                                .is_some_and(|uri| normalize_ws_for_compare(uri) == target_norm)
                        })
                    });
                if !matches_ws {
                    continue;
                }
                if let Some(settings) = v.get("settings") {
                    for key in ["permissionPreset", "autoExecutionPolicy", "artifactReviewMode"] {
                        if let Some(val) = settings.get(key).and_then(|x| x.as_str()) {
                            if let Some(mapped) = map_antigravity_policy_str(val) {
                                return Some(mapped.to_string());
                            }
                        }
                    }
                }
            }
        }
    }

    // 2. Fall back to global userSettings in `~/.gemini/config/config.json`
    let cfg_path = config_dir.join("config.json");
    let raw = std::fs::read_to_string(&cfg_path).ok()?;
    let v: serde_json::Value = serde_json::from_str(&raw).ok()?;
    let us = v.get("userSettings")?;
    for key in ["permissionPreset", "autoExecutionPolicy", "artifactReviewMode"] {
        if let Some(val) = us.get(key).and_then(|x| x.as_str()) {
            if let Some(mapped) = map_antigravity_policy_str(val) {
                return Some(mapped.to_string());
            }
        }
    }
    None
}

/// Terminates a headless child process tree strictly spawned and tracked by NOVA (`bg_pids`).
pub fn kill_owned_child_tree(pid: u32) -> Result<(), String> {
    if pid <= 4 || pid == std::process::id() {
        return Err("Invalid child PID".to_string());
    }
    let _ = silent_cmd("taskkill")
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .output()
        .map_err(|e| format!("Failed to stop headless agent process: {e}"))?;
    Ok(())
}

/// Saves a base64 PNG data URL to `%LOCALAPPDATA%\NOVA\snips\` so `agy.exe` can inspect screenshots directly.
pub fn save_snip_png_to_disk(data_url: &str) -> Option<PathBuf> {
    let b64_part = data_url
        .trim()
        .split_once(";base64,")
        .map(|(_, b)| b)
        .unwrap_or_else(|| data_url.trim());
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(b64_part)
        .ok()?;
    if bytes.is_empty() || bytes.len() > 12 * 1024 * 1024 {
        return None;
    }

    let snips_dir = nova_data_dir().join("snips");
    let _ = std::fs::create_dir_all(&snips_dir);

    // Prune older snips beyond 20 files to keep disk clean
    if let Ok(entries) = std::fs::read_dir(&snips_dir) {
        let mut files: Vec<PathBuf> = entries
            .flatten()
            .map(|e| e.path())
            .filter(|p| p.is_file())
            .collect();
        if files.len() > 20 {
            files.sort();
            for old in files.iter().take(files.len().saturating_sub(20)) {
                let _ = std::fs::remove_file(old);
            }
        }
    }

    let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S");
    let short_id = &uuid::Uuid::new_v4().simple().to_string()[..6];
    let out_path = snips_dir.join(format!("snip-{stamp}-{short_id}.png"));
    std::fs::write(&out_path, bytes).ok()?;
    Some(out_path)
}

/// Discovers active and nearby developer workspaces for the Island workspace selector.
pub fn discover_recent_workspaces(active_paths: &[String]) -> Vec<WorkspaceEntry> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();

    let mut push_dir = |p: &Path| {
        let Ok(canon_or_clean) = std::fs::metadata(p).map(|m| m.is_dir()) else {
            return;
        };
        if !canon_or_clean {
            return;
        }
        let path_str = p.to_string_lossy().trim_end_matches(['\\', '/']).to_string();
        if path_str.is_empty() {
            return;
        }
        let key = path_str.to_ascii_lowercase();
        if seen.insert(key) {
            let name = p
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .filter(|n| !n.is_empty())
                .unwrap_or_else(|| path_str.clone());
            out.push(WorkspaceEntry {
                name,
                path: path_str,
            });
        }
    };

    for ap in active_paths {
        push_dir(Path::new(ap));
    }

    if let Ok(cwd) = std::env::current_dir() {
        push_dir(&cwd);
    }

    let is_code_repo = |dir: &Path| -> bool {
        [
            ".git",
            "package.json",
            "Cargo.toml",
            "pyproject.toml",
            "go.mod",
            "pubspec.yaml",
        ]
        .iter()
        .any(|marker| dir.join(marker).exists())
    };

    if let Some(home) = std::env::var_os("USERPROFILE") {
        let home_pb = PathBuf::from(home);
        let roots = [
            home_pb.join("Desktop"),
            home_pb.join("Projects"),
            home_pb.join("Repos"),
            home_pb.join("source").join("repos"),
            home_pb.join("Documents").join("GitHub"),
        ];
        let mut added = 0usize;
        for root in roots {
            let Ok(entries) = std::fs::read_dir(&root) else {
                continue;
            };
            for entry in entries.flatten().take(40) {
                if added >= 16 {
                    break;
                }
                let p = entry.path();
                if p.is_dir() && is_code_repo(&p) {
                    push_dir(&p);
                    added += 1;
                }
            }
        }
    }

    out
}

pub fn launch_workspace_session(
    workspace_path: &str,
    agent_cli: &str,
    initial_prompt: Option<&str>,
) -> Result<String, String> {
    let dir_buf = if workspace_path.trim().is_empty() {
        std::env::var_os("USERPROFILE")
            .map(std::path::PathBuf::from)
            .or_else(|| std::env::current_dir().ok())
            .unwrap_or_else(|| std::path::PathBuf::from("."))
    } else {
        std::path::PathBuf::from(workspace_path.trim())
    };

    if !dir_buf.is_dir() {
        return Err("Workspace path must be an existing directory".to_string());
    }
    let dir = dir_buf.to_string_lossy().to_string();

    // Strict allowlist of permitted agent CLIs — never interpolate arbitrary executable names
    let cli_cmd = match agent_cli.trim() {
        "antigravity" => "antigravity",
        "claude" => "claude",
        "codex" => "codex",
        "gemini" => "gemini",
        "powershell" => "",
        other => return Err(format!("Unsupported agent CLI: {other}")),
    };

    let clean_prompt = initial_prompt
        .map(|p| p.trim())
        .filter(|p| !p.is_empty() && p.len() <= 8000);

    // Pass initial prompt via environment variable so user text is NEVER parsed as PowerShell syntax
    let ps_command = if cli_cmd.is_empty() {
        "Write-Host 'NOVA Workspace Terminal Ready' -ForegroundColor Cyan".to_string()
    } else if clean_prompt.is_some() {
        format!("& '{cli_cmd}' $env:NOVA_INITIAL_PROMPT")
    } else {
        format!("& '{cli_cmd}'")
    };

    // Prefer Windows Terminal (`wt.exe`), fallback to standalone PowerShell
    let mut wt = silent_cmd("wt.exe");
    if let Some(p) = clean_prompt {
        wt.env("NOVA_INITIAL_PROMPT", p);
    }
    if wt
        .args([
            "-d",
            &dir,
            "powershell",
            "-NoProfile",
            "-NoExit",
            "-Command",
            &ps_command,
        ])
        .spawn()
        .is_ok()
    {
        return Ok(format!("Launched session in Windows Terminal ({dir})"));
    }

    let mut ps = Command::new("powershell");
    if let Some(p) = clean_prompt {
        ps.env("NOVA_INITIAL_PROMPT", p);
    }
    ps.current_dir(&dir)
        .args(["-NoProfile", "-NoExit", "-Command", &ps_command])
        .spawn()
        .map_err(|e| format!("Failed launching terminal: {e}"))?;

    Ok(format!("Launched session in PowerShell ({dir})"))
}

/// Brings the terminal or IDE window owning an agent session to the foreground.
#[cfg(windows)]
pub fn focus_session_window(chain: &[ProcessAncestor], fallback_workspace: &str) -> Result<String, String> {
    use windows::Win32::Foundation::{BOOL, HWND, LPARAM};
    use windows::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetWindowThreadProcessId, IsWindowVisible, SetForegroundWindow, ShowWindow,
        SW_RESTORE,
    };

    let target_pids: Vec<u32> = chain
        .iter()
        .filter(|p| {
            let n = p.name.to_ascii_lowercase();
            !n.contains("nova-hook") && !n.contains("conhost") && !n.contains("cmd.exe")
        })
        .map(|p| p.pid)
        .collect();

    struct SearchCtx {
        pids: Vec<u32>,
        found: Option<HWND>,
    }

    unsafe extern "system" fn enum_cb(hwnd: HWND, lparam: LPARAM) -> BOOL {
        let ctx = &mut *(lparam.0 as *mut SearchCtx);
        if !IsWindowVisible(hwnd).as_bool() {
            return BOOL(1);
        }
        let mut win_pid: u32 = 0;
        GetWindowThreadProcessId(hwnd, Some(&mut win_pid));
        if ctx.pids.contains(&win_pid) {
            ctx.found = Some(hwnd);
            return BOOL(0);
        }
        BOOL(1)
    }

    let mut ctx = SearchCtx {
        pids: target_pids,
        found: None,
    };

    unsafe {
        let _ = EnumWindows(Some(enum_cb), LPARAM(&mut ctx as *mut SearchCtx as isize));
        if let Some(hwnd) = ctx.found {
            let _ = ShowWindow(hwnd, SW_RESTORE);
            let _ = SetForegroundWindow(hwnd);
            return Ok("Focused active session window".to_string());
        }
    }

    if !fallback_workspace.is_empty() {
        return open_in_editor(fallback_workspace, None, Some("antigravity"));
    }
    Err("Could not locate session window".to_string())
}

#[cfg(not(windows))]
pub fn focus_session_window(_chain: &[ProcessAncestor], _fallback_workspace: &str) -> Result<String, String> {
    Ok("Window focus is supported on Windows".to_string())
}

/// Detects if the user's current foreground window covers the entire monitor (e.g., fullscreen video or game).
#[cfg(windows)]
pub fn is_foreground_fullscreen() -> bool {
    use windows::Win32::Foundation::RECT;
    use windows::Win32::Graphics::Gdi::{GetMonitorInfoW, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTONEAREST};
    use windows::Win32::UI::WindowsAndMessaging::{
        GetDesktopWindow, GetForegroundWindow, GetShellWindow, GetWindowLongW, GetWindowRect,
        GWL_STYLE, WS_CAPTION, WS_THICKFRAME,
    };

    unsafe {
        let fg = GetForegroundWindow();
        if fg.0.is_null() || fg == GetDesktopWindow() || fg == GetShellWindow() {
            return false;
        }

        // Maximized browser and desktop windows can have a DWM rectangle that
        // reaches the monitor edges. Their caption/resizable frame identifies
        // them as ordinary windows, so don't suppress NOVA hover for them.
        let style = GetWindowLongW(fg, GWL_STYLE) as u32;
        if style & (WS_CAPTION.0 | WS_THICKFRAME.0) != 0 {
            return false;
        }

        let mut win_rect = RECT::default();
        if GetWindowRect(fg, &mut win_rect).is_err() {
            return false;
        }
        let mon = MonitorFromWindow(fg, MONITOR_DEFAULTTONEAREST);
        let mut mi = MONITORINFO {
            cbSize: std::mem::size_of::<MONITORINFO>() as u32,
            ..Default::default()
        };
        if !GetMonitorInfoW(mon, &mut mi).as_bool() {
            return false;
        }
        let mr = mi.rcMonitor;
        win_rect.left <= mr.left
            && win_rect.top <= mr.top
            && win_rect.right >= mr.right
            && win_rect.bottom >= mr.bottom
    }
}

#[cfg(not(windows))]
pub fn is_foreground_fullscreen() -> bool {
    false
}

/// Reads current Windows Global System Media Transport Controls (Spotify, YouTube Music, Chrome, Edge, etc.).
#[cfg(windows)]
pub fn get_windows_media_status() -> MediaStatus {
    use windows::Media::Control::{
        GlobalSystemMediaTransportControlsSessionManager,
        GlobalSystemMediaTransportControlsSessionPlaybackStatus,
    };

    let run = || -> Option<MediaStatus> {
        let manager = GlobalSystemMediaTransportControlsSessionManager::RequestAsync()
            .ok()?
            .get()
            .ok()?;
        let session = manager.GetCurrentSession().ok()?;
        let source_app = session
            .SourceAppUserModelId()
            .ok()
            .map(|s| s.to_string())
            .unwrap_or_default();
        let info = session.GetPlaybackInfo().ok()?;
        let playing = info.PlaybackStatus().ok()?
            == GlobalSystemMediaTransportControlsSessionPlaybackStatus::Playing;
        let props = session.TryGetMediaPropertiesAsync().ok()?.get().ok()?;
        let title = props.Title().ok().map(|s| s.to_string()).unwrap_or_default();
        let artist = props.Artist().ok().map(|s| s.to_string()).unwrap_or_default();

        Some(MediaStatus {
            active: !title.is_empty(),
            playing,
            title,
            artist,
            source_app,
        })
    };

    run().unwrap_or(MediaStatus {
        active: false,
        playing: false,
        title: String::new(),
        artist: String::new(),
        source_app: String::new(),
    })
}

#[cfg(not(windows))]
pub fn get_windows_media_status() -> MediaStatus {
    MediaStatus {
        active: false,
        playing: false,
        title: String::new(),
        artist: String::new(),
        source_app: String::new(),
    }
}

#[cfg(windows)]
pub fn control_windows_media(action: &str) -> Result<MediaStatus, String> {
    use windows::Media::Control::GlobalSystemMediaTransportControlsSessionManager;

    let manager = GlobalSystemMediaTransportControlsSessionManager::RequestAsync()
        .map_err(|e| e.to_string())?
        .get()
        .map_err(|e| e.to_string())?;
    let session = manager
        .GetCurrentSession()
        .map_err(|_| "No active Windows media session".to_string())?;

    match action {
        "toggle" => {
            let _ = session
                .TryTogglePlayPauseAsync()
                .map_err(|e| e.to_string())?
                .get();
        }
        "next" => {
            let _ = session.TrySkipNextAsync().map_err(|e| e.to_string())?.get();
        }
        "prev" => {
            let _ = session
                .TrySkipPreviousAsync()
                .map_err(|e| e.to_string())?
                .get();
        }
        _ => return Err(format!("Unknown media action: {action}")),
    }

    Ok(get_windows_media_status())
}

#[cfg(not(windows))]
pub fn control_windows_media(_action: &str) -> Result<MediaStatus, String> {
    Ok(get_windows_media_status())
}

/// Captures the primary display as a PNG data URL (`data:image/png;base64,...`) for instant Vision AI analysis.
pub fn capture_screen_data_url() -> Result<String, String> {
    let temp_png = std::env::temp_dir().join(format!("nova-snip-{}.png", uuid::Uuid::new_v4()));
    let path_escaped = temp_png.to_string_lossy().replace('\'', "''");

    let ps_script = format!(
        "Add-Type -AssemblyName System.Windows.Forms,System.Drawing; \
         $b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds; \
         $bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height; \
         $g = [System.Drawing.Graphics]::FromImage($bmp); \
         $g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size); \
         $bmp.Save('{path_escaped}', [System.Drawing.Imaging.ImageFormat]::Png); \
         $g.Dispose(); $bmp.Dispose();"
    );

    let out = silent_cmd("powershell")
        .args(["-NoProfile", "-Command", &ps_script])
        .output()
        .map_err(|e| format!("Screen capture failed: {e}"))?;

    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }

    let bytes = std::fs::read(&temp_png).map_err(|e| format!("Failed reading captured PNG: {e}"))?;
    let _ = std::fs::remove_file(&temp_png);
    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Ok(format!("data:image/png;base64,{b64}"))
}

pub fn read_clipboard_text() -> Option<String> {
    let mut cb = arboard::Clipboard::new().ok()?;
    cb.get_text().ok().filter(|s| !s.trim().is_empty())
}

pub fn write_clipboard_text(text: &str) -> Result<(), String> {
    let mut cb = arboard::Clipboard::new().map_err(|e| e.to_string())?;
    cb.set_text(text.to_string()).map_err(|e| e.to_string())
}

/// Pastes text into the currently focused application while preserving the user's prior clipboard text.
pub fn paste_preserving_clipboard(text: &str) -> Result<(), String> {
    let previous = read_clipboard_text();
    write_clipboard_text(text)?;

    #[cfg(windows)]
    {
        use windows::Win32::UI::Input::KeyboardAndMouse::{
            SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_KEYUP, VIRTUAL_KEY,
            VK_CONTROL, VK_V,
        };
        let make_key = |vk: VIRTUAL_KEY, up: bool| INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: vk,
                    wScan: 0,
                    dwFlags: if up {
                        KEYEVENTF_KEYUP
                    } else {
                        Default::default()
                    },
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        };
        let inputs = [
            make_key(VK_CONTROL, false),
            make_key(VK_V, false),
            make_key(VK_V, true),
            make_key(VK_CONTROL, true),
        ];
        unsafe {
            let _ = SendInput(&inputs, std::mem::size_of::<INPUT>() as i32);
        }
    }

    if let Some(prev) = previous {
        let prev_clone = prev.clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(280));
            let _ = write_clipboard_text(&prev_clone);
        });
    }
    Ok(())
}

/// Checks `Ctrl+Alt+<Key>` bindings for potential AltGr character collisions on international Windows keyboard layouts.
pub fn annotate_altgr_conflicts(shortcuts: &mut [ShortcutBinding]) {
    let known_altgr_hazards = [
        ("Ctrl+Alt+E", "Can type '€' on European AltGr layouts"),
        ("Ctrl+Alt+M", "Can type 'µ' on German AltGr layouts"),
        ("Ctrl+Alt+2", "Can type '@' or '²' on European AltGr layouts"),
    ];
    for sc in shortcuts.iter_mut() {
        sc.altgr_conflict = known_altgr_hazards
            .iter()
            .find(|(acc, _)| sc.accelerator.eq_ignore_ascii_case(acc))
            .map(|(_, note)| note.to_string());
    }
}

pub fn local_lan_ipv4() -> String {
    if let Ok(sock) = std::net::UdpSocket::bind("0.0.0.0:0") {
        if sock.connect("8.8.8.8:80").is_ok() {
            if let Ok(addr) = sock.local_addr() {
                return addr.ip().to_string();
            }
        }
    }
    "127.0.0.1".to_string()
}
