use crate::models::AgyHookStatus;
use crate::risk::render_line_diff;
use serde_json::{json, Map, Value};
use std::env;
use std::fs;
use std::path::PathBuf;

pub fn nova_data_dir() -> PathBuf {
    let mut base = env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .or_else(|| env::var_os("USERPROFILE").map(|p| PathBuf::from(p).join("AppData\\Local")))
        .unwrap_or_else(env::temp_dir);
    base.push("NOVA");
    let _ = fs::create_dir_all(&base);
    base
}

pub fn installed_hook_exe_path() -> PathBuf {
    let bin_dir = nova_data_dir().join("bin");
    let _ = fs::create_dir_all(&bin_dir);
    bin_dir.join("nova-hook.exe")
}

/// Ensures `nova-hook.exe` is copied into `%LOCALAPPDATA%\NOVA\bin\nova-hook.exe`
/// from the workspace build (`target/release/nova-hook.exe` or `target/debug/nova-hook.exe`
/// or sibling directory of `nova.exe`) so hooks survive rebuilds and directory moves.
pub fn sync_hook_binary() -> PathBuf {
    let dest = installed_hook_exe_path();
    let mut candidates: Vec<PathBuf> = Vec::new();

    if let Ok(exe) = env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(dir.join("nova-hook.exe"));
        }
    }
    if let Ok(cwd) = env::current_dir() {
        candidates.push(cwd.join("target").join("release").join("nova-hook.exe"));
        candidates.push(cwd.join("target").join("debug").join("nova-hook.exe"));
        if let Some(parent) = cwd.parent() {
            candidates.push(parent.join("target").join("release").join("nova-hook.exe"));
            candidates.push(parent.join("target").join("debug").join("nova-hook.exe"));
        }
    }

    for src in candidates {
        if src.exists() && src != dest {
            let _ = fs::copy(&src, &dest);
            break;
        }
    }
    upgrade_existing_pretool_timeout_if_installed();
    dest
}

/// Keeps an already-installed `hooks.json` `nova.PreToolUse` timeout at >=180s so interactive
/// `ask_question` prompts in NOVA never cut off prematurely after 10s/120s.
fn upgrade_existing_pretool_timeout_if_installed() {
    let hooks_path = antigravity_hooks_json_path();
    let Ok(raw) = fs::read_to_string(&hooks_path) else {
        return;
    };
    if raw.trim().is_empty() {
        return;
    }
    let Ok(mut root) = serde_json::from_str::<Value>(&raw) else {
        return;
    };
    let mut updated = false;
    if let Some(pre_arr) = root
        .get_mut("nova")
        .and_then(|n| n.get_mut("PreToolUse"))
        .and_then(|v| v.as_array_mut())
    {
        for matcher_entry in pre_arr {
            if let Some(hooks) = matcher_entry.get_mut("hooks").and_then(|h| h.as_array_mut()) {
                for hk in hooks {
                    let cur_t = hk.get("timeout").and_then(|t| t.as_u64()).unwrap_or(0);
                    if cur_t > 0 && cur_t < 180 {
                        hk["timeout"] = json!(300);
                        updated = true;
                    }
                }
            }
        }
    }
    if updated {
        if let Ok(serialized) = serde_json::to_string_pretty(&root) {
            let _ = fs::write(&hooks_path, format!("{serialized}\n"));
        }
    }
}

/// Ensures `%APPDATA%\Microsoft\Windows\Start Menu\Programs\NOVA.lnk` exists and points to `nova.exe`
/// so NOVA appears natively under Apps in Windows Search (`Win` -> `nova`) even before running an installer.
pub fn sync_start_menu_shortcut() {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;

        let Ok(exe) = env::current_exe() else {
            return;
        };
        let is_nova_bin = exe
            .file_name()
            .and_then(|n| n.to_str())
            .is_some_and(|n| n.eq_ignore_ascii_case("nova.exe"));
        if !is_nova_bin || !exe.is_file() {
            return;
        }
        let Some(appdata) = env::var_os("APPDATA").map(PathBuf::from) else {
            return;
        };
        let programs_dir = appdata
            .join("Microsoft")
            .join("Windows")
            .join("Start Menu")
            .join("Programs");
        let _ = fs::create_dir_all(&programs_dir);
        let lnk_path = programs_dir.join("NOVA.lnk");

        let exe_str = exe.to_string_lossy().replace('\'', "''");
        let wd_str = exe
            .parent()
            .unwrap_or_else(|| std::path::Path::new("."))
            .to_string_lossy()
            .replace('\'', "''");
        let lnk_str = lnk_path.to_string_lossy().replace('\'', "''");

        let ps = format!(
            "$ws = New-Object -ComObject WScript.Shell; \
             $s = $ws.CreateShortcut('{lnk_str}'); \
             if ($s.TargetPath -ne '{exe_str}') {{ \
                 $s.TargetPath = '{exe_str}'; \
                 $s.WorkingDirectory = '{wd_str}'; \
                 $s.IconLocation = '{exe_str},0'; \
                 $s.Description = 'NOVA — Personal AI Agent Mission Control & Dynamic Island'; \
                 $s.Save(); \
             }}"
        );

        let _ = std::process::Command::new("powershell")
            .creation_flags(CREATE_NO_WINDOW)
            .args(["-NoProfile", "-Command", &ps])
            .output();
    }
}

pub fn antigravity_hooks_json_path() -> PathBuf {
    let home = env::var_os("USERPROFILE")
        .or_else(|| env::var_os("HOME"))
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."));
    home.join(".gemini").join("config").join("hooks.json")
}

fn build_nova_hook_group(hook_exe: &str, approve_in_island: bool) -> Value {
    let pre_timeout = if approve_in_island { 300 } else { 180 };
    let quoted_exe = if hook_exe.contains(' ') {
        format!("\"{hook_exe}\"")
    } else {
        hook_exe.to_string()
    };

    json!({
        "enabled": true,
        "SessionStart": [
            {
                "type": "command",
                "command": format!("{quoted_exe} --agent antigravity SessionStart"),
                "timeout": 10
            }
        ],
        "PreToolUse": [
            {
                "matcher": "*",
                "hooks": [
                    {
                        "type": "command",
                        "command": format!("{quoted_exe} --agent antigravity PreToolUse"),
                        "timeout": pre_timeout
                    }
                ]
            }
        ],
        "PostToolUse": [
            {
                "matcher": "*",
                "hooks": [
                    {
                        "type": "command",
                        "command": format!("{quoted_exe} --agent antigravity PostToolUse"),
                        "timeout": 10
                    }
                ]
            }
        ],
        "PreInvocation": [
            {
                "type": "command",
                "command": format!("{quoted_exe} --agent antigravity PreInvocation"),
                "timeout": 10
            }
        ],
        "PostInvocation": [
            {
                "type": "command",
                "command": format!("{quoted_exe} --agent antigravity PostInvocation"),
                "timeout": 10
            }
        ],
        "Stop": [
            {
                "type": "command",
                "command": format!("{quoted_exe} --agent antigravity Stop"),
                "timeout": 10
            }
        ]
    })
}

pub fn inspect_antigravity_hooks(approve_in_island: bool) -> AgyHookStatus {
    let hooks_path = antigravity_hooks_json_path();
    let hook_bin = sync_hook_binary();
    let hook_bin_str = hook_bin.to_string_lossy().to_string();

    let raw_existing = fs::read_to_string(&hooks_path).unwrap_or_default();
    let mut root_map: Map<String, Value> = if raw_existing.trim().is_empty() {
        Map::new()
    } else {
        serde_json::from_str::<Value>(&raw_existing)
            .ok()
            .and_then(|v| v.as_object().cloned())
            .unwrap_or_default()
    };

    let nova_installed = root_map.contains_key("nova");
    let nova_enabled = root_map
        .get("nova")
        .and_then(|v| v.get("enabled"))
        .and_then(|b| b.as_bool())
        .unwrap_or(nova_installed);

    let coucou_detected = root_map.contains_key("coucou");
    let coucou_enabled = root_map
        .get("coucou")
        .and_then(|v| v.get("enabled"))
        .and_then(|b| b.as_bool())
        .unwrap_or(coucou_detected);

    root_map.insert(
        "nova".to_string(),
        build_nova_hook_group(&hook_bin_str, approve_in_island),
    );
    let proposed_json =
        serde_json::to_string_pretty(&Value::Object(root_map)).unwrap_or_else(|_| "{}".into());

    let diff = render_line_diff(
        &hooks_path.to_string_lossy(),
        if raw_existing.is_empty() {
            "{}\n"
        } else {
            &raw_existing
        },
        &proposed_json,
    );

    AgyHookStatus {
        hooks_json_path: hooks_path.to_string_lossy().to_string(),
        hook_binary_path: hook_bin_str,
        hook_binary_exists: hook_bin.exists(),
        nova_installed,
        nova_enabled,
        coucou_detected,
        coucou_enabled,
        diff_preview: diff.unified_diff,
        proposed_json,
    }
}

/// Applies a reviewed hook mutation (`install`, `uninstall`, or `toggle_coucou`)
/// only after writing a timestamped backup alongside `hooks.json`.
pub fn apply_antigravity_hooks(
    action: &str,
    approve_in_island: bool,
) -> Result<(AgyHookStatus, Option<String>), String> {
    let hooks_path = antigravity_hooks_json_path();
    if let Some(parent) = hooks_path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Failed to create config dir: {e}"))?;
    }

    let raw_existing = fs::read_to_string(&hooks_path).unwrap_or_default();
    let mut root_map: Map<String, Value> = if raw_existing.trim().is_empty() {
        Map::new()
    } else {
        serde_json::from_str::<Value>(&raw_existing)
            .map_err(|e| format!("Refusing to modify malformed hooks.json: {e}"))?
            .as_object()
            .cloned()
            .ok_or_else(|| "hooks.json root must be a JSON object".to_string())?
    };

    let backup_path = if hooks_path.exists() {
        let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S");
        let bak = hooks_path.with_file_name(format!("hooks.json.nova-bak-{stamp}"));
        fs::write(&bak, &raw_existing)
            .map_err(|e| format!("Failed to write dated backup before editing hooks.json: {e}"))?;
        Some(bak.to_string_lossy().to_string())
    } else {
        None
    };

    let hook_bin = sync_hook_binary();
    let hook_bin_str = hook_bin.to_string_lossy().to_string();

    match action {
        "install" => {
            root_map.insert(
                "nova".to_string(),
                build_nova_hook_group(&hook_bin_str, approve_in_island),
            );
        }
        "uninstall" => {
            root_map.remove("nova");
        }
        "disable_coucou" => {
            if let Some(coucou_obj) = root_map.get_mut("coucou").and_then(|v| v.as_object_mut()) {
                coucou_obj.insert("enabled".to_string(), Value::Bool(false));
            }
        }
        "enable_coucou" => {
            if let Some(coucou_obj) = root_map.get_mut("coucou").and_then(|v| v.as_object_mut()) {
                coucou_obj.insert("enabled".to_string(), Value::Bool(true));
            }
        }
        other => return Err(format!("Unsupported hook action: {other}")),
    }

    let serialized = serde_json::to_string_pretty(&Value::Object(root_map))
        .map_err(|e| format!("Serialization error: {e}"))?;
    fs::write(&hooks_path, format!("{serialized}\n"))
        .map_err(|e| format!("Failed writing hooks.json: {e}"))?;

    Ok((inspect_antigravity_hooks(approve_in_island), backup_path))
}
