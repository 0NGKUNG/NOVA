use crate::models::{
    ActionItem, ChatMessage, GitHubOverview, GitHubPullItem, GitHubWorkflowItem,
    MobilePairingInfo, SecretPresenceMap, TechTerm, VoiceNote, VoiceSnippet,
};
use base64::Engine;
use keyring::Entry;
use qrcode::render::svg;
use qrcode::QrCode;
use serde_json::{json, Value};
use std::process::Command;

const KEYRING_SERVICE: &str = "app.nova.missioncontrol";

const SECRET_KEYS: &[&str] = &[
    "gemini",
    "anthropic",
    "openai",
    "groq",
    "openrouter",
    "github",
    "telegram_token",
    "telegram_chat_id",
];

pub fn set_secret(name: &str, value: &str) -> Result<(), String> {
    if !SECRET_KEYS.contains(&name) {
        return Err(format!("Unsupported secret slot: {name}"));
    }
    let entry = Entry::new(KEYRING_SERVICE, name).map_err(|e| e.to_string())?;
    if value.trim().is_empty() {
        let _ = entry.delete_credential();
        return Ok(());
    }
    entry.set_password(value.trim()).map_err(|e| e.to_string())
}

pub fn get_secret(name: &str) -> Option<String> {
    let entry = Entry::new(KEYRING_SERVICE, name).ok()?;
    entry.get_password().ok().filter(|v| !v.trim().is_empty())
}

pub fn secret_presence_map() -> SecretPresenceMap {
    SecretPresenceMap {
        gemini: get_secret("gemini").is_some(),
        anthropic: get_secret("anthropic").is_some(),
        openai: get_secret("openai").is_some(),
        groq: get_secret("groq").is_some(),
        openrouter: get_secret("openrouter").is_some(),
        github: get_secret("github").is_some(),
        telegram_token: get_secret("telegram_token").is_some(),
        telegram_chat_id: get_secret("telegram_chat_id").is_some(),
    }
}

fn split_thinking(raw: &str) -> (String, Option<String>) {
    if let (Some(start), Some(end)) = (raw.find("<think>"), raw.find("</think>")) {
        if end > start + 7 {
            let thought = raw[start + 7..end].trim().to_string();
            let rest = format!("{}{}", &raw[..start], &raw[end + 8..])
                .trim()
                .to_string();
            return (rest, if thought.is_empty() { None } else { Some(thought) });
        }
    }
    (raw.trim().to_string(), None)
}

/// Sends a chat request to any supported backend:
/// - `gemini` (Google Generative Language API, supports inline base64 Vision)
/// - `anthropic` (Claude Messages API, supports inline base64 Vision)
/// - `openai` / `groq` / `openrouter` / `ollama` / `lmstudio` (OpenAI-compatible Chat Completions)
/// - `cli-gemini` / `cli-claude` / `cli-codex` (Zero-Key CLI Subscription Relay)
pub async fn run_ai_chat(
    provider: &str,
    model: &str,
    system_prompt: &str,
    history: &[ChatMessage],
    ollama_url: &str,
    lmstudio_url: &str,
) -> Result<(String, Option<String>, String), String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(65))
        .build()
        .map_err(|e| e.to_string())?;

    match provider {
        "gemini" => {
            let api_key = get_secret("gemini")
                .or_else(|| std::env::var("GEMINI_API_KEY").ok())
                .ok_or_else(|| {
                    "No Gemini API key stored. Add one in NOVA Hub -> AI & Keys, or switch to Ollama / CLI Relay.".to_string()
                })?;
            let chosen_model = if model.is_empty() {
                "gemini-2.5-flash"
            } else {
                model
            };
            let url = format!(
                "https://generativelanguage.googleapis.com/v1beta/models/{chosen_model}:generateContent?key={api_key}"
            );

            let mut contents = Vec::new();
            for m in history {
                if m.role == "system" {
                    continue;
                }
                let role = if m.role == "assistant" { "model" } else { "user" };
                let mut parts = vec![json!({ "text": m.content })];
                if let Some(data_url) = &m.image_data_url {
                    if let Some((meta, b64)) = data_url.split_once(',') {
                        let mime = meta
                            .strip_prefix("data:")
                            .and_then(|s| s.strip_suffix(";base64"))
                            .unwrap_or("image/png");
                        parts.push(json!({
                            "inline_data": {
                                "mime_type": mime,
                                "data": b64
                            }
                        }));
                    }
                }
                contents.push(json!({ "role": role, "parts": parts }));
            }

            let payload = json!({
                "system_instruction": {
                    "parts": [{ "text": system_prompt }]
                },
                "contents": contents
            });

            let resp = client
                .post(&url)
                .json(&payload)
                .send()
                .await
                .map_err(|e| format!("Gemini request failed: {e}"))?;

            let status = resp.status();
            let val: Value = resp.json().await.map_err(|e| e.to_string())?;
            if !status.is_success() {
                let msg = val["error"]["message"]
                    .as_str()
                    .unwrap_or("Gemini API returned an error");
                return Err(format!("Gemini ({status}): {msg}"));
            }
            let text = val["candidates"][0]["content"]["parts"][0]["text"]
                .as_str()
                .unwrap_or("(Empty response)")
                .to_string();
            let (clean, think) = split_thinking(&text);
            Ok((clean, think, chosen_model.to_string()))
        }

        "anthropic" => {
            let api_key = get_secret("anthropic")
                .or_else(|| std::env::var("ANTHROPIC_API_KEY").ok())
                .ok_or_else(|| "No Anthropic API key stored in Windows Credential Manager.".to_string())?;
            let chosen_model = if model.is_empty() {
                "claude-sonnet-4-20250514"
            } else {
                model
            };

            let mut messages = Vec::new();
            for m in history {
                if m.role == "system" {
                    continue;
                }
                let role = if m.role == "assistant" { "assistant" } else { "user" };
                if let Some(data_url) = &m.image_data_url {
                    if let Some((meta, b64)) = data_url.split_once(',') {
                        let mime = meta
                            .strip_prefix("data:")
                            .and_then(|s| s.strip_suffix(";base64"))
                            .unwrap_or("image/png");
                        messages.push(json!({
                            "role": role,
                            "content": [
                                {
                                    "type": "image",
                                    "source": { "type": "base64", "media_type": mime, "data": b64 }
                                },
                                { "type": "text", "text": m.content }
                            ]
                        }));
                        continue;
                    }
                }
                messages.push(json!({ "role": role, "content": m.content }));
            }

            let resp = client
                .post("https://api.anthropic.com/v1/messages")
                .header("x-api-key", api_key)
                .header("anthropic-version", "2023-06-01")
                .json(&json!({
                    "model": chosen_model,
                    "max_tokens": 2048,
                    "system": system_prompt,
                    "messages": messages
                }))
                .send()
                .await
                .map_err(|e| format!("Anthropic request failed: {e}"))?;

            let status = resp.status();
            let val: Value = resp.json().await.map_err(|e| e.to_string())?;
            if !status.is_success() {
                let msg = val["error"]["message"]
                    .as_str()
                    .unwrap_or("Anthropic API error");
                return Err(format!("Anthropic ({status}): {msg}"));
            }
            let text = val["content"][0]["text"]
                .as_str()
                .unwrap_or("(Empty response)")
                .to_string();
            let (clean, think) = split_thinking(&text);
            Ok((clean, think, chosen_model.to_string()))
        }

        "openai" | "groq" | "openrouter" | "ollama" | "lmstudio" => {
            let (endpoint, key_opt, default_model) = match provider {
                "openai" => (
                    "https://api.openai.com/v1/chat/completions".to_string(),
                    Some(
                        get_secret("openai")
                            .or_else(|| std::env::var("OPENAI_API_KEY").ok())
                            .ok_or_else(|| "No OpenAI API key stored.".to_string())?,
                    ),
                    "gpt-4o-mini",
                ),
                "groq" => (
                    "https://api.groq.com/openai/v1/chat/completions".to_string(),
                    Some(
                        get_secret("groq")
                            .or_else(|| std::env::var("GROQ_API_KEY").ok())
                            .ok_or_else(|| "No Groq API key stored.".to_string())?,
                    ),
                    "llama-3.3-70b-versatile",
                ),
                "openrouter" => (
                    "https://openrouter.ai/api/v1/chat/completions".to_string(),
                    Some(
                        get_secret("openrouter")
                            .ok_or_else(|| "No OpenRouter API key stored.".to_string())?,
                    ),
                    "anthropic/claude-3.5-sonnet",
                ),
                "ollama" => (
                    format!("{}/v1/chat/completions", ollama_url.trim_end_matches('/')),
                    None,
                    "qwen2.5-coder:7b",
                ),
                _ => (
                    format!("{}/v1/chat/completions", lmstudio_url.trim_end_matches('/')),
                    None,
                    "local-model",
                ),
            };

            let chosen_model = if model.is_empty() {
                default_model
            } else {
                model
            };

            let mut msgs = vec![json!({ "role": "system", "content": system_prompt })];
            for m in history {
                if m.role == "system" {
                    continue;
                }
                if let Some(data_url) = &m.image_data_url {
                    msgs.push(json!({
                        "role": m.role,
                        "content": [
                            { "type": "text", "text": m.content },
                            { "type": "image_url", "image_url": { "url": data_url } }
                        ]
                    }));
                } else {
                    msgs.push(json!({ "role": m.role, "content": m.content }));
                }
            }

            let mut req = client.post(&endpoint).json(&json!({
                "model": chosen_model,
                "messages": msgs
            }));
            if let Some(k) = key_opt {
                req = req.bearer_auth(k);
            }

            let resp = req
                .send()
                .await
                .map_err(|e| format!("{provider} connection failed ({endpoint}): {e}"))?;
            let status = resp.status();
            let val: Value = resp.json().await.map_err(|e| e.to_string())?;
            if !status.is_success() {
                let msg = val["error"]["message"]
                    .as_str()
                    .unwrap_or("Chat completion error");
                return Err(format!("{provider} ({status}): {msg}"));
            }
            let text = val["choices"][0]["message"]["content"]
                .as_str()
                .unwrap_or("(Empty response)")
                .to_string();
            let (clean, think) = split_thinking(&text);
            Ok((clean, think, chosen_model.to_string()))
        }

        "cli-gemini" | "cli-claude" | "cli-antigravity" => {
            let last_prompt = history
                .last()
                .map(|m| m.content.clone())
                .unwrap_or_default();
            let full_prompt = format!("{system_prompt}\n\nUser: {last_prompt}");
            let cli_name = match provider {
                "cli-claude" => "claude.cmd",
                "cli-gemini" => "gemini.cmd",
                _ => "gemini.cmd",
            };
            let output = tokio::task::spawn_blocking(move || {
                Command::new(cli_name).args(["-p", &full_prompt]).output()
            })
            .await
            .map_err(|e| e.to_string())?
            .map_err(|e| {
                format!(
                    "CLI Subscription Relay `{cli_name}` not found on PATH ({e}). Install the CLI or select an API/Local provider."
                )
            })?;

            if !output.status.success() {
                return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
            }
            let reply = String::from_utf8_lossy(&output.stdout).trim().to_string();
            let (clean, think) = split_thinking(&reply);
            Ok((clean, think, format!("{provider}-subscription")))
        }

        other => Err(format!("Unsupported chat provider: {other}")),
    }
}

/// Applies Tech Dictionary canonical spellings and Voice Snippet expansions to a transcript.
pub fn post_process_transcript(
    raw: &str,
    dictionary: &[TechTerm],
    snippets: &[VoiceSnippet],
) -> String {
    let trimmed = raw.trim();
    for snip in snippets {
        if trimmed.eq_ignore_ascii_case(snip.trigger.trim()) {
            return snip.expansion.clone();
        }
    }
    let mut result = trimmed.to_string();
    for term in dictionary {
        if !term.spoken.trim().is_empty() {
            // Case-insensitive replacement for spoken tech terms (including Thai phonetic spellings!)
            let lower_res = result.to_lowercase();
            let needle = term.spoken.trim().to_lowercase();
            if lower_res.contains(&needle) {
                result = replace_case_insensitive(&result, &term.spoken, &term.canonical);
            }
        }
    }
    result
}

fn replace_case_insensitive(haystack: &str, needle: &str, replacement: &str) -> String {
    if needle.is_empty() {
        return haystack.to_string();
    }
    let mut out = String::with_capacity(haystack.len());
    let lower_hay = haystack.to_lowercase();
    let lower_needle = needle.to_lowercase();
    let mut last = 0;
    for (idx, _) in lower_hay.match_indices(&lower_needle) {
        if haystack.is_char_boundary(idx) && haystack.is_char_boundary(idx + needle.len()) {
            out.push_str(&haystack[last..idx]);
            out.push_str(replacement);
            last = idx + needle.len();
        }
    }
    out.push_str(&haystack[last..]);
    out
}

/// Hybrid Bilingual (Thai + English) Audio Transcription via Groq Whisper, OpenAI Whisper, or Gemini Multimodal.
pub async fn transcribe_audio_bytes(
    stt_provider: &str,
    audio_bytes: Vec<u8>,
    mime_type: &str,
    dictionary: &[TechTerm],
) -> Result<String, String> {
    let vocab_hint: String = dictionary
        .iter()
        .map(|t| t.canonical.as_str())
        .collect::<Vec<_>>()
        .join(", ");
    let prompt_hint = format!(
        "Bilingual Thai (ภาษาไทย) and English developer dictation with code-switching. Preserve exact technical terms: {vocab_hint}"
    );

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(45))
        .build()
        .map_err(|e| e.to_string())?;

    if stt_provider == "gemini" || (stt_provider == "groq" && get_secret("groq").is_none() && get_secret("gemini").is_some()) {
        let key = get_secret("gemini")
            .ok_or_else(|| "Configure a Groq, Gemini, or OpenAI key for cloud STT, or use Web Speech mode.".to_string())?;
        let b64 = base64::engine::general_purpose::STANDARD.encode(&audio_bytes);
        let url = format!(
            "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key={key}"
        );
        let resp = client
            .post(&url)
            .json(&json!({
                "contents": [{
                    "parts": [
                        { "text": format!("Transcribe this audio verbatim, preserving bilingual Thai and English technical terms ({vocab_hint}). Return ONLY the transcript text with no commentary.") },
                        { "inline_data": { "mime_type": mime_type, "data": b64 } }
                    ]
                }]
            }))
            .send()
            .await
            .map_err(|e| e.to_string())?;
        let val: Value = resp.json().await.map_err(|e| e.to_string())?;
        let text = val["candidates"][0]["content"]["parts"][0]["text"]
            .as_str()
            .ok_or_else(|| format!("Gemini STT error: {val}"))?;
        return Ok(text.trim().to_string());
    }

    let (endpoint, key, model) = if stt_provider == "openai" {
        (
            "https://api.openai.com/v1/audio/transcriptions",
            get_secret("openai")
                .ok_or_else(|| "No OpenAI API key configured for Whisper STT.".to_string())?,
            "whisper-1",
        )
    } else {
        (
            "https://api.groq.com/openai/v1/audio/transcriptions",
            get_secret("groq").ok_or_else(|| {
                "No Groq API key configured. Add a Groq/Gemini/OpenAI key in Hub -> AI & Keys, or switch STT to Browser Web Speech.".to_string()
            })?,
            "whisper-large-v3-turbo",
        )
    };

    let ext = if mime_type.contains("wav") { "wav" } else { "webm" };
    let file_part = reqwest::multipart::Part::bytes(audio_bytes)
        .file_name(format!("dictation.{ext}"))
        .mime_str(mime_type)
        .map_err(|e| e.to_string())?;

    let form = reqwest::multipart::Form::new()
        .part("file", file_part)
        .text("model", model.to_string())
        .text("prompt", prompt_hint);

    let resp = client
        .post(endpoint)
        .bearer_auth(key)
        .multipart(form)
        .send()
        .await
        .map_err(|e| format!("Whisper STT request failed: {e}"))?;

    let status = resp.status();
    let val: Value = resp.json().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(val["error"]["message"]
            .as_str()
            .unwrap_or("Whisper transcription failed")
            .to_string());
    }
    Ok(val["text"].as_str().unwrap_or_default().trim().to_string())
}

/// Summarizes a meeting or voice memo transcript into bilingual summary + checkable action items.
pub async fn summarize_voice_note(
    title: &str,
    mode: &str,
    language: &str,
    transcript: &str,
    duration_sec: u64,
    chat_provider: &str,
    chat_model: &str,
    ollama_url: &str,
    lmstudio_url: &str,
) -> VoiceNote {
    let word_count = transcript.split_whitespace().count();
    let sys = if language == "th" {
        "คุณคือ NOVA Notetaker สรุปข้อความประชุมหรือบันทึกเสียงเป็นภาษาไทยผสมคำศัพท์เทคนิคภาษาอังกฤษอย่างกระชับ รูปแบบ:\nSUMMARY:\n<สรุปใจความสำคัญ 2-4 ประโยค>\nTODOS:\n- <งานที่ต้องทำ 1>\n- <งานที่ต้องทำ 2>"
    } else {
        "You are NOVA Notetaker. Summarize this transcript concisely (preserving Thai + English bilingual technical nuances). Format strictly as:\nSUMMARY:\n<2-4 sentence summary>\nTODOS:\n- <action item 1>\n- <action item 2>"
    };

    let user_msg = ChatMessage {
        id: "tmp".into(),
        role: "user".into(),
        content: transcript.to_string(),
        thinking: None,
        provider: None,
        model: None,
        image_data_url: None,
        attached_file: None,
        timestamp: chrono::Utc::now().to_rfc3339(),
    };

    let (summary, action_items) = match run_ai_chat(
        chat_provider,
        chat_model,
        sys,
        &[user_msg],
        ollama_url,
        lmstudio_url,
    )
    .await
    {
        Ok((reply, _, _)) => {
            let (sum_part, todo_part) = reply
                .split_once("TODOS:")
                .unwrap_or((reply.as_str(), ""));
            let clean_sum = sum_part.replace("SUMMARY:", "").trim().to_string();
            let todos: Vec<ActionItem> = todo_part
                .lines()
                .map(|l| l.trim().trim_start_matches('-').trim_start_matches('*').trim())
                .filter(|l| !l.is_empty())
                .map(|text| ActionItem {
                    id: uuid::Uuid::new_v4().to_string(),
                    text: text.to_string(),
                    done: false,
                })
                .collect();
            (clean_sum, todos)
        }
        Err(_) => {
            // Clean offline extractive fallback when no AI key is configured yet
            let preview: String = transcript.chars().take(240).collect();
            let items: Vec<ActionItem> = transcript
                .split(['.', '\n'])
                .map(|s| s.trim())
                .filter(|s| {
                    let l = s.to_lowercase();
                    l.contains("todo")
                        || l.contains("need to")
                        || l.contains("ต้อง")
                        || l.contains("ฝาก")
                        || l.contains("follow up")
                })
                .take(4)
                .map(|t| ActionItem {
                    id: uuid::Uuid::new_v4().to_string(),
                    text: t.to_string(),
                    done: false,
                })
                .collect();
            (preview, items)
        }
    };

    VoiceNote {
        id: uuid::Uuid::new_v4().to_string(),
        title: if title.trim().is_empty() {
            format!("NOVA {} — {}", if mode == "meeting" { "Meeting" } else { "Voice Memo" }, chrono::Local::now().format("%H:%M"))
        } else {
            title.to_string()
        },
        mode: mode.to_string(),
        language: language.to_string(),
        raw_transcript: transcript.to_string(),
        summary,
        action_items,
        duration_sec,
        word_count,
        created_at: chrono::Utc::now().to_rfc3339(),
    }
}

/// Polls GitHub for the authenticated user's open PRs, requested reviews, and recent Actions workflow runs.
pub async fn fetch_github_overview() -> GitHubOverview {
    let Some(token) = get_secret("github").or_else(|| std::env::var("GITHUB_TOKEN").ok()) else {
        return GitHubOverview {
            connected: false,
            username: None,
            avatar_url: None,
            my_prs: Vec::new(),
            review_requests: Vec::new(),
            recent_runs: Vec::new(),
            fetched_at: None,
            error: None,
        };
    };

    let client = match reqwest::Client::builder()
        .user_agent("NOVA-MissionControl/1.0")
        .timeout(std::time::Duration::from_secs(15))
        .build()
    {
        Ok(c) => c,
        Err(e) => {
            return GitHubOverview {
                connected: false,
                username: None,
                avatar_url: None,
                my_prs: Vec::new(),
                review_requests: Vec::new(),
                recent_runs: Vec::new(),
                fetched_at: None,
                error: Some(e.to_string()),
            }
        }
    };

    let user_resp = match client
        .get("https://api.github.com/user")
        .bearer_auth(&token)
        .send()
        .await
    {
        Ok(r) => r,
        Err(e) => {
            return GitHubOverview {
                connected: false,
                username: None,
                avatar_url: None,
                my_prs: Vec::new(),
                review_requests: Vec::new(),
                recent_runs: Vec::new(),
                fetched_at: None,
                error: Some(format!("GitHub unreachable: {e}")),
            }
        }
    };

    if !user_resp.status().is_success() {
        return GitHubOverview {
            connected: false,
            username: None,
            avatar_url: None,
            my_prs: Vec::new(),
            review_requests: Vec::new(),
            recent_runs: Vec::new(),
            fetched_at: None,
            error: Some(format!("GitHub auth rejected ({})", user_resp.status())),
        };
    }

    let user_json: Value = user_resp.json().await.unwrap_or_default();
    let login = user_json["login"].as_str().unwrap_or_default().to_string();
    let avatar_url = user_json["avatar_url"].as_str().map(|s| s.to_string());

    let parse_search_prs = |val: &Value| -> Vec<GitHubPullItem> {
        val["items"]
            .as_array()
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .take(8)
            .map(|item| {
                let repo_url = item["repository_url"].as_str().unwrap_or_default();
                let repo = repo_url
                    .split("/repos/")
                    .nth(1)
                    .unwrap_or(repo_url)
                    .to_string();
                GitHubPullItem {
                    number: item["number"].as_u64().unwrap_or(0),
                    title: item["title"].as_str().unwrap_or_default().to_string(),
                    repo,
                    url: item["html_url"].as_str().unwrap_or_default().to_string(),
                    state: item["state"].as_str().unwrap_or("open").to_string(),
                    draft: item["draft"].as_bool().unwrap_or(false),
                    updated_at: item["updated_at"].as_str().unwrap_or_default().to_string(),
                }
            })
            .collect()
    };

    let my_q = format!("https://api.github.com/search/issues?q=is:open+is:pr+author:{login}&per_page=8");
    let rev_q = format!("https://api.github.com/search/issues?q=is:open+is:pr+review-requested:{login}&per_page=8");
    let repos_q = "https://api.github.com/user/repos?sort=pushed&per_page=3";

    let (my_res, rev_res, repos_res) = tokio::join!(
        client.get(&my_q).bearer_auth(&token).send(),
        client.get(&rev_q).bearer_auth(&token).send(),
        client.get(repos_q).bearer_auth(&token).send(),
    );

    let my_prs = match my_res {
        Ok(r) => parse_search_prs(&r.json::<Value>().await.unwrap_or_default()),
        Err(_) => Vec::new(),
    };
    let review_requests = match rev_res {
        Ok(r) => parse_search_prs(&r.json::<Value>().await.unwrap_or_default()),
        Err(_) => Vec::new(),
    };

    let mut recent_runs = Vec::new();
    if let Ok(r) = repos_res {
        if let Ok(repos) = r.json::<Vec<Value>>().await {
            for repo in repos.into_iter().take(3) {
                if let Some(full_name) = repo["full_name"].as_str() {
                    let runs_url = format!(
                        "https://api.github.com/repos/{full_name}/actions/runs?per_page=2"
                    );
                    if let Ok(rr) = client.get(&runs_url).bearer_auth(&token).send().await {
                        if let Ok(rj) = rr.json::<Value>().await {
                            for run in rj["workflow_runs"].as_array().cloned().unwrap_or_default() {
                                recent_runs.push(GitHubWorkflowItem {
                                    id: run["id"].as_u64().unwrap_or(0),
                                    name: run["name"].as_str().unwrap_or("Workflow").to_string(),
                                    repo: full_name.to_string(),
                                    status: run["status"].as_str().unwrap_or("completed").to_string(),
                                    conclusion: run["conclusion"].as_str().map(|s| s.to_string()),
                                    branch: run["head_branch"].as_str().unwrap_or("main").to_string(),
                                    url: run["html_url"].as_str().unwrap_or_default().to_string(),
                                });
                            }
                        }
                    }
                }
            }
        }
    }

    GitHubOverview {
        connected: true,
        username: Some(login),
        avatar_url,
        my_prs,
        review_requests,
        recent_runs,
        fetched_at: Some(chrono::Utc::now().to_rfc3339()),
        error: None,
    }
}

pub fn build_mobile_pairing_info(
    enabled: bool,
    lan_ip: &str,
    port: u16,
    pairing_token: &str,
    telegram_enabled: bool,
) -> MobilePairingInfo {
    let mobile_url = format!("http://{lan_ip}:{port}/?surface=mobile&token={pairing_token}");
    let qr_svg = QrCode::new(mobile_url.as_bytes())
        .map(|code| {
            code.render::<svg::Color>()
                .min_dimensions(180, 180)
                .dark_color(svg::Color("#22d3ee"))
                .light_color(svg::Color("#090d16"))
                .build()
        })
        .unwrap_or_default();

    let telegram_configured =
        get_secret("telegram_token").is_some() && get_secret("telegram_chat_id").is_some();

    MobilePairingInfo {
        enabled,
        lan_ip: lan_ip.to_string(),
        port,
        mobile_url,
        pairing_token: pairing_token.to_string(),
        qr_svg,
        telegram_configured,
        telegram_enabled,
    }
}

/// Sends an interactive `[Allow]` / `[Deny]` notification to Telegram when Telegram Bridge is enabled.
pub async fn send_telegram_approval_alert(
    approval_id: &str,
    workspace_name: &str,
    tool_name: &str,
    detail: &str,
    risk_level: &str,
) {
    let (Some(bot_token), Some(chat_id)) =
        (get_secret("telegram_token"), get_secret("telegram_chat_id"))
    else {
        return;
    };

    let text = format!(
        "🛰 *NOVA Approval Required*\n• *Workspace:* `{workspace_name}`\n• *Tool:* `{tool_name}`\n• *Risk:* `{risk_level}`\n```\n{}\n```",
        detail.chars().take(350).collect::<String>()
    );

    let url = format!("https://api.telegram.org/bot{bot_token}/sendMessage");
    let _ = reqwest::Client::new()
        .post(&url)
        .json(&json!({
            "chat_id": chat_id,
            "text": text,
            "parse_mode": "Markdown",
            "reply_markup": {
                "inline_keyboard": [[
                    { "text": "✅ Allow", "callback_data": format!("allow:{approval_id}") },
                    { "text": "❌ Deny", "callback_data": format!("deny:{approval_id}") }
                ]]
            }
        }))
        .send()
        .await;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tech_dictionary_and_snippets_expand_bilingual_terms() {
        let dict = vec![
            TechTerm {
                spoken: "แอนติกราวิตี้".into(),
                canonical: "Antigravity".into(),
            },
            TechTerm {
                spoken: "เทาริ".into(),
                canonical: "Tauri v2".into(),
            },
        ];
        let snippets = vec![VoiceSnippet {
            trigger: "run check".into(),
            expansion: "cargo check && npm run build".into(),
        }];

        assert_eq!(
            post_process_transcript("run check", &dict, &snippets),
            "cargo check && npm run build"
        );
        assert_eq!(
            post_process_transcript("เชื่อมต่อ แอนติกราวิตี้ กับ เทาริ", &dict, &snippets),
            "เชื่อมต่อ Antigravity กับ Tauri v2"
        );
    }
}
