use crate::models::{FileDiffPreview, RiskAssessment};
use serde_json::Value;
use std::fs;
use std::path::Path;

/// Splits a shell script into logical command segments and returns the normalized executable token
/// of each segment (skipping leading `&`, `cmd /c`, env assignments, and punctuation).
fn command_segment_heads(lower: &str) -> Vec<(String, String)> {
    let mut out = Vec::new();
    for raw_seg in lower.split(['\n', '\r', ';', '|']) {
        for sub in raw_seg.split("&&") {
            let mut tokens = sub.split_whitespace().peekable();
            while let Some(&tok) = tokens.peek() {
                let clean = tok.trim_matches(|c: char| matches!(c, '(' | ')' | '{' | '}' | '&' | '@' | '\'' | '"'));
                if clean.is_empty()
                    || clean == "&"
                    || (clean.contains('=') && !clean.starts_with('-'))
                {
                    tokens.next();
                    continue;
                }
                if clean == "cmd" || clean == "cmd.exe" {
                    tokens.next();
                    if tokens.peek().is_some_and(|t| *t == "/c" || *t == "/k") {
                        tokens.next();
                    }
                    continue;
                }
                let head = clean.to_string();
                let rest: Vec<&str> = tokens.skip(1).collect();
                out.push((head, rest.join(" ")));
                break;
            }
        }
    }
    out
}

/// Evaluates the operational risk of a tool invocation (`run_command`, `write_file`, `edit_file`, etc.)
/// and proposes a clean reusable 1-click allow rule pattern when appropriate.
pub fn assess_tool_risk(
    tool_name: &str,
    command_line: Option<&str>,
    target_file: Option<&str>,
) -> RiskAssessment {
    let mut score: u8 = 10;
    let mut reasons = Vec::new();
    let mut tags = Vec::new();
    let mut suggested_rule_pattern = None;

    if let Some(cmd) = command_line {
        let trimmed = cmd.trim();
        let lower = trimmed.to_ascii_lowercase();
        let segments = command_segment_heads(&lower);

        // Extract leading executable / subcommand for 1-click rule suggestion
        let parts: Vec<&str> = trimmed.split_whitespace().collect();
        if !parts.is_empty() {
            let prefix = if parts.len() >= 2
                && matches!(
                    parts[0].to_ascii_lowercase().as_str(),
                    "npm" | "npx" | "pnpm" | "yarn" | "cargo" | "git" | "dotnet" | "python" | "uv"
                ) {
                format!("{} {}", parts[0], parts[1])
            } else {
                parts[0].to_string()
            };
            suggested_rule_pattern = Some(prefix);
        }

        // Critical / destructive multi-word patterns
        let critical_markers = [
            ("rm -rf", "Recursive force deletion (`rm -rf`)"),
            ("remove-item -recurse -force", "Recursive force deletion in PowerShell"),
            ("del /f /s /q", "Recursive silent file deletion"),
            ("format-volume", "Disk volume format command detected"),
            ("clear-disk", "Disk wipe command (`Clear-Disk`) detected"),
            ("git push --force", "Force-push rewrites remote Git history"),
            ("git push -f", "Force-push rewrites remote Git history"),
            ("git reset --hard", "Hard reset discards uncommitted work"),
            ("git clean -fd", "Deletes untracked workspace files permanently"),
            ("drop database", "Destructive database drop statement"),
            ("drop table", "Destructive table drop statement"),
            ("invoke-expression", "Dynamic script execution (`Invoke-Expression`)"),
            ("reg delete", "Windows Registry deletion"),
        ];

        for (pat, msg) in critical_markers {
            if lower.contains(pat) {
                score = score.max(92);
                reasons.push(msg.to_string());
                if !tags.contains(&"destructive".to_string()) {
                    tags.push("destructive".to_string());
                }
            }
        }

        // Token-boundary critical commands (prevents `--output-format` matching `format ` or `codex ` matching `iex `)
        for (head, rest) in &segments {
            if matches!(head.as_str(), "format" | "format.com")
                && rest.split_whitespace().any(|arg| {
                    let a = arg.trim_matches(|c: char| c == '"' || c == '\'');
                    a.len() == 2 && a.ends_with(':') && a.chars().next().is_some_and(|c| c.is_ascii_alphabetic())
                })
            {
                score = score.max(95);
                reasons.push("Disk format command detected".to_string());
                if !tags.contains(&"destructive".to_string()) {
                    tags.push("destructive".to_string());
                }
            }
            if head == "iex" {
                score = score.max(92);
                reasons.push("Dynamic remote/string script execution (`iex`)".to_string());
                if !tags.contains(&"destructive".to_string()) {
                    tags.push("destructive".to_string());
                }
            }
        }

        // High-risk network / privilege / process patterns
        let is_local_only_http = (lower.contains("127.0.0.1") || lower.contains("localhost"))
            && !lower.contains("https://");
        let high_markers = [
            ("winget ", "System package installation/modification", "system-pkg"),
            ("choco ", "Chocolatey system package operation", "system-pkg"),
            ("stop-process", "Terminates OS processes", "process-kill"),
            ("taskkill", "Terminates OS processes", "process-kill"),
            ("curl ", "External network transfer", "network"),
            ("invoke-webrequest", "External HTTP request", "network"),
            ("invoke-restmethod", "External REST API call", "network"),
            ("ssh ", "Remote shell connection", "remote"),
            ("scp ", "Remote file transfer", "remote"),
            ("npm publish", "Publishes package to registry", "publish"),
            ("cargo publish", "Publishes crate to registry", "publish"),
        ];

        for (pat, msg, tag) in high_markers {
            if tag == "network" && is_local_only_http {
                continue;
            }
            if lower.contains(pat) {
                score = score.max(68);
                reasons.push(msg.to_string());
                if !tags.contains(&tag.to_string()) {
                    tags.push(tag.to_string());
                }
            }
        }

        // Medium-risk mutation / build / install commands
        let medium_markers = [
            ("npm install", "Installs or modifies Node dependencies", "deps"),
            ("npm.cmd install", "Installs or modifies Node dependencies", "deps"),
            ("pnpm install", "Installs or modifies pnpm dependencies", "deps"),
            ("cargo add", "Modifies Rust Cargo dependencies", "deps"),
            ("pip install", "Installs Python packages", "deps"),
            ("git commit", "Creates a Git commit", "git-write"),
            ("git push", "Pushes commits to remote repository", "git-remote"),
            ("git checkout", "Switches branches or overwrites working files", "git-write"),
            ("move-item", "Moves or renames filesystem entries", "fs-write"),
            ("new-item", "Creates filesystem entries", "fs-write"),
        ];

        for (pat, msg, tag) in medium_markers {
            if lower.contains(pat) {
                score = score.max(45);
                reasons.push(msg.to_string());
                if !tags.contains(&tag.to_string()) {
                    tags.push(tag.to_string());
                }
            }
        }

        // Known safe read-only / test / check commands
        let safe_prefixes = [
            "git status",
            "git diff",
            "git log",
            "git branch",
            "get-childitem",
            "get-content",
            "get-item",
            "get-command",
            "select-string",
            "test-path",
            "node -v",
            "npm -v",
            "rustc -v",
            "cargo -v",
            "cargo check",
            "cargo test",
            "npm test",
            "npm run test",
            "npm run build",
            "tsc --noemit",
            "where.exe",
            "dir",
            "ls",
            "pwd",
            "echo ",
            "write-output",
        ];

        let has_chain = lower.contains(';')
            || lower.contains("&&")
            || lower.contains("||")
            || lower.contains('|');

        if score <= 15 && safe_prefixes.iter().any(|p| lower.starts_with(p)) && !has_chain {
            score = 5;
            reasons.push("Verified read-only inspection or local test/check command".to_string());
            tags.push("read-or-test".to_string());
        } else if reasons.is_empty() {
            score = 35;
            reasons.push("Shell command execution in workspace".to_string());
            tags.push("shell".to_string());
        }
    } else if matches!(
        tool_name,
        "read_file" | "view_file" | "grep_search" | "find_by_name" | "list_dir"
    ) {
        score = 3;
        reasons.push("Read-only workspace inspection".to_string());
        tags.push("read-only".to_string());
    } else if matches!(
        tool_name,
        "write_file" | "edit_file" | "Write" | "Edit" | "MultiEdit"
    ) {
        score = 30;
        if let Some(fp) = target_file {
            let lower_fp = fp.to_ascii_lowercase();
            if lower_fp.contains(".env")
                || lower_fp.contains("credentials")
                || lower_fp.contains(".gemini\\config")
                || lower_fp.contains("id_rsa")
            {
                score = 82;
                reasons.push(format!("Modifies sensitive config or credential file: {fp}"));
                tags.push("sensitive-file".to_string());
            } else {
                reasons.push(format!("Edits workspace file: {fp}"));
                tags.push("file-edit".to_string());
            }
            suggested_rule_pattern = Path::new(fp)
                .parent()
                .map(|p| p.to_string_lossy().to_string());
        } else {
            reasons.push("Modifies file on disk".to_string());
            tags.push("file-edit".to_string());
        }
    } else {
        score = 20;
        reasons.push(format!("Agent tool invocation: {tool_name}"));
        tags.push("tool".to_string());
        suggested_rule_pattern = Some(tool_name.to_string());
    }

    let level = match score {
        0..=10 => "safe",
        11..=29 => "low",
        30..=59 => "medium",
        60..=84 => "high",
        _ => "critical",
    }
    .to_string();

    RiskAssessment {
        level,
        score,
        reasons,
        tags,
        suggested_rule_pattern,
    }
}

fn unwrap_str_arg(tool_args: &Value, keys: &[&str]) -> Option<String> {
    for k in keys {
        if let Some(v) = tool_args.get(*k) {
            if let Some(s) = v.as_str() {
                let trimmed = s.trim();
                if trimmed.starts_with('"') && trimmed.ends_with('"') {
                    if let Ok(unwrapped) = serde_json::from_str::<String>(trimmed) {
                        return Some(unwrapped);
                    }
                }
                return Some(s.to_string());
            }
        }
    }
    None
}

fn unwrap_bool_arg(tool_args: &Value, key: &str) -> bool {
    if let Some(v) = tool_args.get(key) {
        if let Some(b) = v.as_bool() {
            return b;
        }
        if let Some(s) = v.as_str() {
            return s.trim().trim_matches('"').eq_ignore_ascii_case("true");
        }
    }
    false
}

/// Computes a bounded unified diff preview for `write_file` / `edit_file` / `Edit` / `Write` calls,
/// working both BEFORE execution (`PreToolUse`), AFTER execution (`PostToolUse`), and from `transcript.jsonl`.
pub fn build_file_diff_preview(
    tool_name: &str,
    target_file: Option<&str>,
    tool_args: &Value,
) -> Option<FileDiffPreview> {
    let resolved_path = target_file
        .map(|s| s.to_string())
        .or_else(|| unwrap_str_arg(tool_args, &["Path", "TargetFile", "file_path", "AbsolutePath"]))?;
    let path_str = resolved_path.trim();
    if path_str.is_empty() {
        return None;
    }

    let existing = fs::read_to_string(path_str).unwrap_or_default();
    let mut undo_pair: Option<(String, String)> = None;

    let mut dp = match tool_name {
        "edit_file" | "Edit" | "replace_file_content" => {
            let target = unwrap_str_arg(tool_args, &["Target", "TargetContent", "old_string"])?;
            let replacement =
                unwrap_str_arg(tool_args, &["Replacement", "ReplacementContent", "new_string"])
                    .unwrap_or_default();
            if target.len() <= 64_000 && replacement.len() <= 64_000 {
                undo_pair = Some((target.clone(), replacement.clone()));
            }
            if !existing.is_empty() && existing.contains(&target) {
                // PreToolUse: file still contains `target`
                let proposed = existing.replacen(&target, &replacement, 1);
                render_line_diff(path_str, &existing, &proposed)
            } else if !existing.is_empty()
                && !replacement.is_empty()
                && existing.contains(&replacement)
            {
                // PostToolUse / Transcript hydration: file already contains `replacement` -> recover exact line numbers & context!
                let prior = existing.replacen(&replacement, &target, 1);
                render_line_diff(path_str, &prior, &existing)
            } else {
                render_line_diff(path_str, &target, &replacement)
            }
        }
        "write_file" | "Write" | "write_to_file" => {
            let content = unwrap_str_arg(tool_args, &["Content", "CodeContent", "content"])?;
            let is_append = unwrap_bool_arg(tool_args, "Append");
            let next = if is_append {
                format!("{existing}{content}")
            } else {
                content
            };
            if !is_append && existing == next {
                // PostToolUse / Transcript hydration where file already matches written content
                if next.len() <= 64_000 {
                    undo_pair = Some((String::new(), next.clone()));
                }
                render_line_diff(path_str, "", &next)
            } else {
                if existing.len() <= 64_000 && next.len() <= 64_000 {
                    undo_pair = Some((existing.clone(), next.clone()));
                }
                render_line_diff(path_str, &existing, &next)
            }
        }
        _ => return None,
    };

    if let Some((ut, ur)) = undo_pair {
        dp.undo_target = Some(ut);
        dp.undo_replacement = Some(ur);
    }
    Some(dp)
}

pub fn render_line_diff(file_path: &str, old_text: &str, new_text: &str) -> FileDiffPreview {
    let old_lines: Vec<&str> = old_text.lines().collect();
    let new_lines: Vec<&str> = new_text.lines().collect();

    // Cap diff computation to keep UI snappy even on huge files
    if old_lines.len() > 2500 || new_lines.len() > 2500 {
        let added = new_lines.len().saturating_sub(old_lines.len());
        let removed = old_lines.len().saturating_sub(new_lines.len());
        return FileDiffPreview {
            file_path: file_path.to_string(),
            added_lines: added.max(1),
            removed_lines: removed,
            unified_diff: format!(
                "--- a/{file_path}\n+++ b/{file_path}\n@@ Large file ({} -> {} lines) @@",
                old_lines.len(),
                new_lines.len()
            ),
            timestamp: chrono::Utc::now().to_rfc3339(),
            start_line: Some(1),
            undo_target: None,
            undo_replacement: None,
            reverted: false,
        };
    }

    // Prefix + Suffix trimming for clean focused unified hunks
    let mut prefix = 0;
    while prefix < old_lines.len()
        && prefix < new_lines.len()
        && old_lines[prefix] == new_lines[prefix]
    {
        prefix += 1;
    }

    let mut old_end = old_lines.len();
    let mut new_end = new_lines.len();
    while old_end > prefix
        && new_end > prefix
        && old_lines[old_end - 1] == new_lines[new_end - 1]
    {
        old_end -= 1;
        new_end -= 1;
    }

    let ctx_start = prefix.saturating_sub(3);
    let old_ctx_end = (old_end + 3).min(old_lines.len());
    let new_ctx_end = (new_end + 3).min(new_lines.len());

    let removed_lines = old_end.saturating_sub(prefix);
    let added_lines = new_end.saturating_sub(prefix);

    let mut out = Vec::new();
    out.push(format!("--- a/{file_path}"));
    out.push(format!("+++ b/{file_path}"));
    out.push(format!(
        "@@ -{},{} +{},{} @@",
        ctx_start + 1,
        old_ctx_end.saturating_sub(ctx_start),
        ctx_start + 1,
        new_ctx_end.saturating_sub(ctx_start)
    ));

    for line in &old_lines[ctx_start..prefix] {
        out.push(format!(" {line}"));
    }
    for line in &old_lines[prefix..old_end] {
        if out.len() < 160 {
            out.push(format!("-{line}"));
        }
    }
    for line in &new_lines[prefix..new_end] {
        if out.len() < 260 {
            out.push(format!("+{line}"));
        }
    }
    let suffix_count = old_ctx_end.saturating_sub(old_end);
    for i in 0..suffix_count {
        if let Some(line) = old_lines.get(old_end + i) {
            if out.len() < 280 {
                out.push(format!(" {line}"));
            }
        }
    }

    FileDiffPreview {
        file_path: file_path.to_string(),
        added_lines,
        removed_lines,
        unified_diff: out.join("\n"),
        timestamp: chrono::Utc::now().to_rfc3339(),
        start_line: Some((prefix + 1) as u32),
        undo_target: None,
        undo_replacement: None,
        reverted: false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn risk_analyzer_flags_destructive_and_safe_commands() {
        let safe = assess_tool_risk("run_command", Some("git status"), None);
        assert_eq!(safe.level, "safe");

        let crit = assess_tool_risk("run_command", Some("git push --force origin main"), None);
        assert_eq!(crit.level, "critical");
        assert!(crit.score >= 90);

        // Regression: `--output-format stream-json` MUST NOT trigger "Disk format command detected"
        let flag_cmd = assess_tool_risk(
            "run_command",
            Some("agy.exe --dangerously-skip-permissions --output-format stream-json -p \"hi\""),
            None,
        );
        assert!(flag_cmd.score < 50, "unexpected high score: {}", flag_cmd.score);
        assert!(!flag_cmd.reasons.iter().any(|r| r.contains("Disk format")));

        // Real disk format command MUST still trigger critical
        let real_fmt = assess_tool_risk("run_command", Some("format D: /q"), None);
        assert_eq!(real_fmt.level, "critical");
        assert!(real_fmt.score >= 90);
    }

    #[test]
    fn unified_diff_renders_clean_hunk() {
        let diff = render_line_diff("src/main.ts", "const a = 1;\nconst b = 2;\n", "const a = 1;\nconst b = 42;\n");
        assert_eq!(diff.added_lines, 1);
        assert_eq!(diff.removed_lines, 1);
        assert!(diff.unified_diff.contains("-const b = 2;"));
        assert!(diff.unified_diff.contains("+const b = 42;"));
    }

    #[test]
    fn edit_file_preview_works_without_existing_file() {
        let args = json!({
            "Target": "oldCall()",
            "Replacement": "newNovaCall()"
        });
        let preview = build_file_diff_preview("edit_file", Some("demo.ts"), &args).unwrap();
        assert_eq!(preview.added_lines, 1);
        assert_eq!(preview.removed_lines, 1);
    }
}
