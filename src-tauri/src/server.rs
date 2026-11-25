use crate::agy_hooks::apply_antigravity_hooks;
use crate::ai_services::{
    fetch_github_overview, post_process_transcript, run_ai_chat, set_secret, summarize_voice_note,
    transcribe_audio_bytes,
};
use crate::models::{
    ApprovalRule, ChatMessage, ChatThread, NormalizedHookEnvelope, NovaSettings, TechTerm,
    TodoItem, VoiceSnippet,
};
use crate::state::{AppCore, CORE_PORT};
use crate::system_tools::{
    annotate_altgr_conflicts, capture_screen_data_url, control_windows_media, focus_session_window,
    get_windows_media_status, kill_process_by_pid, launch_workspace_session, open_in_editor,
    open_url_or_path, paste_preserving_clipboard, read_clipboard_image_data_url,
    sample_hardware_telemetry, scan_listening_ports, write_clipboard_text,
};
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{DefaultBodyLimit, Multipart, Query, Request, State};
use axum::http::header::{AUTHORIZATION, CONTENT_TYPE, ORIGIN};
use axum::http::{HeaderMap, HeaderName, HeaderValue, Method, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Extension, Json, Router};
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::{json, Value};
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use tower_http::cors::{AllowOrigin, CorsLayer};
use tower_http::services::{ServeDir, ServeFile};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum AuthScope {
    PublicHealth,
    DesktopFull,
    MobileCompanion,
}

fn constant_time_eq(a: &str, b: &str) -> bool {
    let ab = a.as_bytes();
    let bb = b.as_bytes();
    if ab.is_empty() || ab.len() != bb.len() {
        return false;
    }
    let mut diff: u8 = 0;
    for (&x, &y) in ab.iter().zip(bb.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

fn is_trusted_origin(origin: &str, lan_ip: &str, lan_enabled: bool) -> bool {
    let o = origin.trim().to_ascii_lowercase();
    if matches!(
        o.as_str(),
        "http://tauri.localhost"
            | "https://tauri.localhost"
            | "tauri://localhost"
            | "http://127.0.0.1:47920"
            | "http://localhost:47920"
            | "http://127.0.0.1:1420"
            | "http://localhost:1420"
    ) {
        return true;
    }
    if lan_enabled && !lan_ip.is_empty() && o == format!("http://{}:47920", lan_ip.to_ascii_lowercase()) {
        return true;
    }
    false
}

fn extract_bearer_or_token(headers: &HeaderMap, query_str: Option<&str>, allow_query_token: bool) -> String {
    if let Some(tok) = headers.get("x-nova-token").and_then(|v| v.to_str().ok()) {
        let trimmed = tok.trim();
        if !trimmed.is_empty() {
            return trimmed.to_string();
        }
    }
    if let Some(auth) = headers.get(AUTHORIZATION).and_then(|v| v.to_str().ok()) {
        if let Some(rest) = auth.trim().strip_prefix("Bearer ") {
            let trimmed = rest.trim();
            if !trimmed.is_empty() {
                return trimmed.to_string();
            }
        }
    }
    if allow_query_token {
        if let Some(qs) = query_str {
            for pair in qs.split('&') {
                if let Some((k, v)) = pair.split_once('=') {
                    if k == "token" && !v.is_empty() {
                        return v.to_string();
                    }
                }
            }
        }
    }
    String::new()
}

fn mobile_route_allowed(path: &str) -> bool {
    matches!(
        path,
        "/ws"
            | "/api/health"
            | "/api/snapshot"
            | "/api/approvals/resolve"
            | "/api/chat/send"
            | "/api/chat/new"
            | "/api/account/switch"
            | "/api/quota"
            | "/api/quota/refresh"
            | "/api/telemetry"
            | "/api/focus/control"
            | "/api/focus/todos"
    )
}

async fn security_gate(
    State(core): State<AppCore>,
    mut req: Request,
    next: Next,
) -> Response {
    let path = req.uri().path().to_string();
    let is_protected = path == "/ws" || path.starts_with("/api/");

    if !is_protected {
        return next.run(req).await;
    }

    let (ipc_token, pairing_token, lan_ip, lan_enabled) = {
        let g = core.inner.lock().unwrap();
        (
            g.ipc_token.clone(),
            g.pairing_token.clone(),
            g.lan_ip.clone(),
            g.settings.remote_lan_enabled,
        )
    };

    // 1. Strict Origin check on every browser request (blocks cross-site localhost CSRF / drive-by attacks)
    if let Some(origin_hdr) = req.headers().get(ORIGIN) {
        let origin_str = origin_hdr.to_str().unwrap_or_default();
        if !is_trusted_origin(origin_str, &lan_ip, lan_enabled) {
            return (
                StatusCode::FORBIDDEN,
                Json(json!({ "ok": false, "error": "Untrusted Origin blocked by NOVA security policy" })),
            )
                .into_response();
        }
    }

    // Allow CORS preflight OPTIONS from verified trusted origins
    if req.method() == Method::OPTIONS {
        return next.run(req).await;
    }

    // Safe unauthenticated liveness check
    if path == "/api/health" {
        req.extensions_mut().insert(AuthScope::PublicHealth);
        return next.run(req).await;
    }

    // 2. Constant-time cryptographic token check
    let provided = extract_bearer_or_token(req.headers(), req.uri().query(), path == "/ws");
    let scope = if constant_time_eq(&provided, &ipc_token) {
        Some(AuthScope::DesktopFull)
    } else if lan_enabled && constant_time_eq(&provided, &pairing_token) {
        Some(AuthScope::MobileCompanion)
    } else {
        None
    };

    let Some(scope) = scope else {
        if path == "/api/hook" {
            return (
                StatusCode::UNAUTHORIZED,
                Json(json!({ "decision": "ask", "reason": "Missing or invalid NOVA IPC token" })),
            )
                .into_response();
        }
        return (
            StatusCode::UNAUTHORIZED,
            Json(json!({ "ok": false, "error": "Unauthorized: valid NOVA security token required" })),
        )
            .into_response();
    };

    // 3. Least-privilege route scoping for Mobile QR Companion
    if scope == AuthScope::MobileCompanion && !mobile_route_allowed(&path) {
        return (
            StatusCode::FORBIDDEN,
            Json(json!({ "ok": false, "error": "Endpoint restricted to local NOVA desktop session" })),
        )
            .into_response();
    }

    req.extensions_mut().insert(scope);
    next.run(req).await
}

pub async fn start_core_http_server(
    core: AppCore,
    prebound_listener: Option<std::net::TcpListener>,
) {
    let dist_dir = resolve_dist_dir();
    let cors_core = core.clone();

    let cors = CorsLayer::new()
        .allow_origin(AllowOrigin::predicate(move |origin: &HeaderValue, _parts| {
            let Ok(origin_str) = origin.to_str() else {
                return false;
            };
            let (lan_ip, lan_enabled) = {
                let g = cors_core.inner.lock().unwrap();
                (g.lan_ip.clone(), g.settings.remote_lan_enabled)
            };
            is_trusted_origin(origin_str, &lan_ip, lan_enabled)
        }))
        .allow_methods([Method::GET, Method::POST, Method::OPTIONS])
        .allow_headers([
            CONTENT_TYPE,
            AUTHORIZATION,
            HeaderName::from_static("x-nova-token"),
        ]);

    let api = Router::new()
        .route("/health", get(api_health))
        .route("/window/wake", post(api_window_wake))
        .route("/snapshot", get(api_snapshot))
        .route("/hook", post(api_hook))
        .route("/approvals/resolve", post(api_resolve_approval))
        .route("/session/send", post(api_session_send))
        .route("/session/stop", post(api_session_stop))
        .route("/session/permission", post(api_session_permission))
        .route("/session/revert-diff", post(api_session_revert_diff))
        .route("/rules/add", post(api_add_rule))
        .route("/rules/delete", post(api_delete_rule))
        .route("/settings", post(api_save_settings))
        .route("/secrets/set", post(api_set_secret))
        .route("/account/switch", post(api_switch_account))
        .route("/quota", get(api_get_quota))
        .route("/quota/refresh", post(api_refresh_quota))
        .route("/hooks/antigravity", post(api_apply_agy_hooks))
        .route("/telemetry", get(api_telemetry))
        .route("/ports", get(api_ports))
        .route("/ports/kill", post(api_kill_port))
        .route("/media", get(api_media_status))
        .route("/media/control", post(api_media_control))
        .route("/github", get(api_github))
        .route("/chat/send", post(api_chat_send))
        .route("/chat/new", post(api_chat_new))
        .route("/chat/delete", post(api_chat_delete))
        .route("/context/snip", post(api_screen_snip))
        .route("/context/clipboard-image", post(api_clipboard_image))
        .route("/context/clipboard-copy", post(api_clipboard_copy))
        .route("/context/clipboard-pin", post(api_clipboard_pin))
        .route("/workspace/focus", post(api_focus_session))
        .route("/workspace/open-editor", post(api_open_editor))
        .route("/workspace/launch", post(api_launch_session))
        .route("/workspace/open-url", post(api_open_url))
        .route("/focus/control", post(api_focus_control))
        .route("/focus/todos", post(api_focus_todos))
        .route("/focus/scratchpad", post(api_focus_scratchpad))
        .route("/voice/transcribe", post(api_voice_transcribe))
        .route("/voice/process-text", post(api_voice_process_text))
        .route("/voice/save-note", post(api_voice_save_note))
        .route("/voice/toggle-action", post(api_voice_toggle_action))
        .route("/voice/dictionary", post(api_save_dictionary))
        .route("/voice/snippets", post(api_save_snippets))
        .route("/recap/devlog", get(api_export_devlog));

    let mut app = Router::new()
        .nest("/api", api)
        .route("/ws", get(ws_handler))
        .layer(middleware::from_fn_with_state(core.clone(), security_gate))
        .layer(DefaultBodyLimit::max(32 * 1024 * 1024))
        .layer(cors)
        .with_state(core.clone());

    if let Some(dir) = dist_dir {
        let index_file = dir.join("index.html");
        app = app.fallback_service(ServeDir::new(dir).not_found_service(ServeFile::new(index_file)));
    }

    if let Some(std_listener) = prebound_listener {
        let _ = std_listener.set_nonblocking(true);
        if let Ok(listener) = tokio::net::TcpListener::from_std(std_listener) {
            let _ = axum::serve(listener, app).await;
            return;
        }
    }

    let bind_all = core.inner.lock().unwrap().settings.remote_lan_enabled;
    let addr = if bind_all {
        SocketAddr::from(([0, 0, 0, 0], CORE_PORT))
    } else {
        SocketAddr::from(([127, 0, 0, 1], CORE_PORT))
    };

    if let Ok(listener) = tokio::net::TcpListener::bind(addr).await {
        let _ = axum::serve(listener, app).await;
    }
}

fn resolve_dist_dir() -> Option<PathBuf> {
    let mut candidates = Vec::new();
    if let Ok(cwd) = std::env::current_dir() {
        candidates.push(cwd.join("dist"));
        if let Some(parent) = cwd.parent() {
            candidates.push(parent.join("dist"));
        }
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(dir.join("dist"));
            if let Some(p2) = dir.parent().and_then(|p| p.parent()) {
                candidates.push(p2.join("dist"));
            }
        }
    }
    candidates.into_iter().find(|p| p.join("index.html").exists())
}

async fn api_health() -> Json<Value> {
    Json(json!({ "ok": true, "service": "nova-core", "port": CORE_PORT }))
}

async fn api_window_wake(State(core): State<AppCore>) -> impl IntoResponse {
    let ping_rx = core
        .ui_liveness
        .lock()
        .unwrap()
        .as_ref()
        .map(|ping| ping());
    let _ = core.events_tx.send(json!({ "type": "window_wake" }));
    if let Some(rx) = ping_rx {
        if tokio::time::timeout(std::time::Duration::from_millis(900), rx)
            .await
            .is_err()
        {
            return (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(json!({ "ok": false, "error": "UI event loop unresponsive" })),
            );
        }
    }
    (
        StatusCode::OK,
        Json(json!({
            "ok": true,
            "interactiveDesktop": crate::has_interactive_shell_desktop()
        })),
    )
}

fn snapshot_for_scope(core: &AppCore, scope: AuthScope) -> crate::models::NovaSnapshot {
    let mut snap = core.snapshot();
    if scope == AuthScope::MobileCompanion {
        snap.mobile.pairing_token.clear();
        snap.mobile.qr_svg.clear();
    }
    snap
}

async fn api_snapshot(
    State(core): State<AppCore>,
    Extension(scope): Extension<AuthScope>,
) -> Json<Value> {
    Json(serde_json::to_value(snapshot_for_scope(&core, scope)).unwrap_or_default())
}

async fn api_hook(
    State(core): State<AppCore>,
    Json(envelope): Json<NormalizedHookEnvelope>,
) -> impl IntoResponse {
    let reply = core.handle_hook_event(envelope).await;
    (
        StatusCode::OK,
        Json(serde_json::to_value(reply).unwrap_or_else(|_| json!({}))),
    )
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ResolveApprovalReq {
    approval_id: String,
    decision: String,
    create_rule_scope: Option<String>,
    edited_command: Option<String>,
    deny_reason: Option<String>,
}

async fn api_resolve_approval(
    State(core): State<AppCore>,
    Json(req): Json<ResolveApprovalReq>,
) -> impl IntoResponse {
    match core.resolve_approval(
        &req.approval_id,
        &req.decision,
        req.create_rule_scope.as_deref(),
        req.edited_command.as_deref(),
        req.deny_reason.as_deref(),
    ) {
        Ok(()) => (StatusCode::OK, Json(json!({ "ok": true }))),
        Err(e) => (StatusCode::BAD_REQUEST, Json(json!({ "ok": false, "error": e }))),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ImageAttachmentReq {
    data_url: String,
    name: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionSendReq {
    workspace_path: Option<String>,
    conversation_id: Option<String>,
    prompt: String,
    mode: Option<String>,
    model: Option<String>,
    effort: Option<String>,
    image_data_url: Option<String>,
    images: Option<Vec<ImageAttachmentReq>>,
}

async fn api_session_send(
    State(core): State<AppCore>,
    Json(req): Json<SessionSendReq>,
) -> impl IntoResponse {
    let image_pairs: Option<Vec<(String, Option<String>)>> = req
        .images
        .map(|list| list.into_iter().map(|i| (i.data_url, i.name)).collect());

    match core.dispatch_agent_prompt(
        req.workspace_path.as_deref().unwrap_or_default(),
        req.conversation_id.as_deref(),
        &req.prompt,
        req.mode.as_deref(),
        req.model.as_deref(),
        req.effort.as_deref(),
        req.image_data_url.as_deref(),
        image_pairs.as_deref(),
    ) {
        Ok(val) => (StatusCode::OK, Json(val)),
        Err(e) => (StatusCode::BAD_REQUEST, Json(json!({ "ok": false, "error": e }))),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionStopReq {
    conversation_id: String,
}

async fn api_session_stop(
    State(core): State<AppCore>,
    Json(req): Json<SessionStopReq>,
) -> impl IntoResponse {
    match core.stop_agent_session(&req.conversation_id) {
        Ok(()) => (StatusCode::OK, Json(json!({ "ok": true }))),
        Err(e) => (StatusCode::BAD_REQUEST, Json(json!({ "ok": false, "error": e }))),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionPermReq {
    global_mode: Option<String>,
    conversation_id: Option<String>,
    session_override: Option<String>,
}

async fn api_session_permission(
    State(core): State<AppCore>,
    Json(req): Json<SessionPermReq>,
) -> impl IntoResponse {
    match core.set_permission_mode(
        req.global_mode.as_deref(),
        req.conversation_id.as_deref(),
        req.session_override.as_deref(),
    ) {
        Ok(()) => (StatusCode::OK, Json(json!({ "ok": true }))),
        Err(e) => (StatusCode::BAD_REQUEST, Json(json!({ "ok": false, "error": e }))),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RevertDiffReq {
    conversation_id: String,
    file_path: String,
}

async fn api_session_revert_diff(
    State(core): State<AppCore>,
    Json(req): Json<RevertDiffReq>,
) -> impl IntoResponse {
    match core.revert_file_diff(&req.conversation_id, &req.file_path) {
        Ok(msg) => (StatusCode::OK, Json(json!({ "ok": true, "message": msg }))),
        Err(e) => (StatusCode::BAD_REQUEST, Json(json!({ "ok": false, "error": e }))),
    }
}

async fn api_add_rule(
    State(core): State<AppCore>,
    Json(mut rule): Json<ApprovalRule>,
) -> Json<Value> {
    if rule.id.is_empty() {
        rule.id = uuid::Uuid::new_v4().to_string();
    }
    rule.created_at = chrono::Utc::now().to_rfc3339();
    core.inner.lock().unwrap().approval_rules.insert(0, rule);
    core.persist();
    core.broadcast_snapshot(None);
    Json(json!({ "ok": true }))
}

#[derive(Deserialize)]
struct IdReq {
    id: String,
}

async fn api_delete_rule(State(core): State<AppCore>, Json(req): Json<IdReq>) -> Json<Value> {
    core.inner
        .lock()
        .unwrap()
        .approval_rules
        .retain(|r| r.id != req.id);
    core.persist();
    core.broadcast_snapshot(None);
    Json(json!({ "ok": true }))
}

async fn api_save_settings(
    State(core): State<AppCore>,
    Json(mut settings): Json<NovaSettings>,
) -> Json<Value> {
    annotate_altgr_conflicts(&mut settings.shortcuts);
    core.inner.lock().unwrap().settings = settings;
    core.persist();
    core.broadcast_snapshot(None);
    Json(json!({ "ok": true }))
}

#[derive(Deserialize)]
struct SecretReq {
    name: String,
    value: String,
}

async fn api_set_secret(
    State(core): State<AppCore>,
    Json(req): Json<SecretReq>,
) -> impl IntoResponse {
    match set_secret(&req.name, &req.value) {
        Ok(()) => {
            core.broadcast_snapshot(None);
            (StatusCode::OK, Json(json!({ "ok": true })))
        }
        Err(e) => (StatusCode::BAD_REQUEST, Json(json!({ "ok": false, "error": e }))),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SwitchAccountReq {
    account: String,
}

async fn api_switch_account(
    State(core): State<AppCore>,
    Json(req): Json<SwitchAccountReq>,
) -> impl IntoResponse {
    let acc = if req.account == "second" { "second" } else { "main" };
    {
        let mut g = core.inner.lock().unwrap();
        g.settings.active_account = acc.to_string();
    }
    core.persist();
    core.broadcast_snapshot(Some("ready"));
    (StatusCode::OK, Json(json!({ "ok": true, "activeAccount": acc })))
}

async fn api_get_quota(State(core): State<AppCore>) -> Json<Value> {
    let quota = {
        let g = core.inner.lock().unwrap();
        g.compute_quota_state()
    };
    Json(serde_json::to_value(quota).unwrap_or_default())
}

async fn api_refresh_quota(State(core): State<AppCore>) -> impl IntoResponse {
    let (main_key, second_key) = {
        let _g = core.inner.lock().unwrap();
        (
            crate::ai_services::get_secret("gemini").or_else(|| std::env::var("GEMINI_API_KEY").ok()),
            crate::ai_services::get_secret("gemini_second").or_else(|| std::env::var("GEMINI_API_KEY_SECOND").ok()),
        )
    };

    if let Some(k) = &main_key {
        let (ok, err) = crate::ai_services::probe_gemini_quota(k).await;
        let mut g = core.inner.lock().unwrap();
        if !ok {
            let is_429 = err.as_deref().map(|e| e.contains("429")).unwrap_or(false);
            if is_429 {
                g.quota_tracker.main.last_429 = Some(std::time::Instant::now());
            }
            g.quota_tracker.main.last_probe_status = err;
        } else {
            g.quota_tracker.main.last_429 = None;
            g.quota_tracker.main.last_probe_status = None;
        }
    }

    if let Some(k) = &second_key {
        let (ok, err) = crate::ai_services::probe_gemini_quota(k).await;
        let mut g = core.inner.lock().unwrap();
        if !ok {
            let is_429 = err.as_deref().map(|e| e.contains("429")).unwrap_or(false);
            if is_429 {
                g.quota_tracker.second.last_429 = Some(std::time::Instant::now());
            }
            g.quota_tracker.second.last_probe_status = err;
        } else {
            g.quota_tracker.second.last_429 = None;
            g.quota_tracker.second.last_probe_status = None;
        }
    }

    let quota = {
        let g = core.inner.lock().unwrap();
        g.compute_quota_state()
    };
    core.broadcast_snapshot(None);
    (StatusCode::OK, Json(serde_json::to_value(quota).unwrap_or_default()))
}

#[derive(Deserialize)]
struct HookActionReq {
    action: String,
}

async fn api_apply_agy_hooks(
    State(core): State<AppCore>,
    Json(req): Json<HookActionReq>,
) -> impl IntoResponse {
    let approve_in_island = core.inner.lock().unwrap().settings.agy_approve_in_island;
    match apply_antigravity_hooks(&req.action, approve_in_island) {
        Ok((status, backup_path)) => {
            core.broadcast_snapshot(Some("ready"));
            (
                StatusCode::OK,
                Json(json!({ "ok": true, "status": status, "backupPath": backup_path })),
            )
        }
        Err(e) => (StatusCode::BAD_REQUEST, Json(json!({ "ok": false, "error": e }))),
    }
}

async fn api_telemetry(State(core): State<AppCore>) -> Json<Value> {
    let sys_arc = core.sys.clone();
    let data = tokio::task::spawn_blocking(move || {
        let mut sys = sys_arc.lock().unwrap();
        sample_hardware_telemetry(&mut sys)
    })
    .await
    .unwrap_or_else(|_| crate::models::HardwareTelemetry {
        cpu_percent: 0.0,
        cpu_brand: String::new(),
        core_count: 1,
        ram_used_gb: 0.0,
        ram_total_gb: 0.0,
        ram_percent: 0.0,
        gpu: None,
        top_processes: Vec::new(),
        fullscreen_active: false,
    });
    Json(serde_json::to_value(data).unwrap_or_default())
}

async fn api_ports(State(core): State<AppCore>) -> Json<Value> {
    let sys_arc = core.sys.clone();
    let ports = tokio::task::spawn_blocking(move || {
        let mut sys = sys_arc.lock().unwrap();
        scan_listening_ports(&mut sys)
    })
    .await
    .unwrap_or_default();
    Json(serde_json::to_value(ports).unwrap_or_default())
}

#[derive(Deserialize)]
struct KillPidReq {
    pid: u32,
}

async fn api_kill_port(
    State(core): State<AppCore>,
    Json(req): Json<KillPidReq>,
) -> impl IntoResponse {
    let sys_arc = core.sys.clone();
    let pid = req.pid;
    match tokio::task::spawn_blocking(move || {
        let mut sys = sys_arc.lock().unwrap();
        kill_process_by_pid(&mut sys, pid)
    })
    .await
    .map_err(|e| e.to_string())
    .and_then(|r| r)
    {
        Ok(msg) => (StatusCode::OK, Json(json!({ "ok": true, "message": msg }))),
        Err(e) => (StatusCode::BAD_REQUEST, Json(json!({ "ok": false, "error": e }))),
    }
}

async fn api_media_status() -> Json<Value> {
    let status = tokio::task::spawn_blocking(get_windows_media_status)
        .await
        .unwrap_or_else(|_| crate::models::MediaStatus {
            active: false,
            playing: false,
            title: String::new(),
            artist: String::new(),
            source_app: String::new(),
        });
    Json(serde_json::to_value(status).unwrap_or_default())
}

#[derive(Deserialize)]
struct MediaActionReq {
    action: String,
}

async fn api_media_control(Json(req): Json<MediaActionReq>) -> impl IntoResponse {
    match tokio::task::spawn_blocking(move || control_windows_media(&req.action))
        .await
        .map_err(|e| e.to_string())
        .and_then(|r| r)
    {
        Ok(status) => (StatusCode::OK, Json(json!({ "ok": true, "status": status }))),
        Err(e) => (StatusCode::BAD_REQUEST, Json(json!({ "ok": false, "error": e }))),
    }
}

async fn api_github() -> Json<Value> {
    let overview = fetch_github_overview().await;
    Json(serde_json::to_value(overview).unwrap_or_default())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChatSendReq {
    thread_id: String,
    content: String,
    provider: Option<String>,
    model: Option<String>,
    persona_id: Option<String>,
    image_data_url: Option<String>,
    attached_file: Option<String>,
}

fn is_safe_chat_attachment(fp: &str) -> bool {
    let trimmed = fp.trim();
    if trimmed.is_empty() || trimmed.starts_with(r"\\.\") || trimmed.starts_with(r"\\?\") {
        return false;
    }
    let path = Path::new(trimmed);
    let Ok(meta) = std::fs::metadata(path) else {
        return false;
    };
    if !meta.is_file() || meta.len() > 2 * 1024 * 1024 {
        return false;
    }
    let fname = path
        .file_name()
        .map(|n| n.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();
    if matches!(
        fname.as_str(),
        "ipc.token"
            | "mobile.token"
            | ".env"
            | ".env.local"
            | ".env.production"
            | "id_rsa"
            | "id_ed25519"
            | "hooks.json"
    ) {
        return false;
    }
    true
}

async fn api_chat_send(
    State(core): State<AppCore>,
    Extension(scope): Extension<AuthScope>,
    Json(req): Json<ChatSendReq>,
) -> impl IntoResponse {
    let mut final_content = req.content.clone();
    if scope == AuthScope::DesktopFull {
        if let Some(fp) = &req.attached_file {
            if is_safe_chat_attachment(fp) {
                if let Ok(file_text) = std::fs::read_to_string(fp) {
                    let snippet: String = file_text.chars().take(18_000).collect();
                    final_content =
                        format!("{final_content}\n\n[Attached File: `{fp}`]\n```\n{snippet}\n```");
                }
            }
        }
    }

    let (provider, model, sys_prompt, history, ollama_url, lmstudio_url, active_account) = {
        let mut g = core.inner.lock().unwrap();
        let provider = req
            .provider
            .clone()
            .unwrap_or_else(|| g.settings.default_chat_provider.clone());
        let model = req
            .model
            .clone()
            .unwrap_or_else(|| g.settings.default_chat_model.clone());
        let ollama_url = g.settings.ollama_url.clone();
        let lmstudio_url = g.settings.lmstudio_url.clone();
        let active_account = g.settings.active_account.clone();

        let pos = g
            .threads
            .iter()
            .position(|t| t.id == req.thread_id)
            .unwrap_or(0);

        if g.threads.is_empty() {
            g.threads.push(ChatThread {
                id: req.thread_id.clone(),
                title: req.content.chars().take(42).collect(),
                persona_id: req.persona_id.clone().unwrap_or_else(|| "architect".into()),
                messages: Vec::new(),
                updated_at: chrono::Utc::now().to_rfc3339(),
            });
        }

        if let Some(pid) = &req.persona_id {
            g.threads[pos].persona_id = pid.clone();
        }
        let active_pid = g.threads[pos].persona_id.clone();
        let sys_prompt = g
            .personas
            .iter()
            .find(|p| p.id == active_pid)
            .map(|p| p.system_prompt.clone())
            .unwrap_or_else(|| "You are NOVA AI.".into());

        g.threads[pos].messages.push(ChatMessage {
            id: uuid::Uuid::new_v4().to_string(),
            role: "user".into(),
            content: final_content,
            thinking: None,
            provider: Some(provider.clone()),
            model: Some(model.clone()),
            image_data_url: req.image_data_url.clone(),
            attached_file: req.attached_file.clone(),
            timestamp: chrono::Utc::now().to_rfc3339(),
        });
        if g.threads[pos].messages.len() <= 2 {
            g.threads[pos].title = req.content.chars().take(44).collect();
        }
        g.threads[pos].updated_at = chrono::Utc::now().to_rfc3339();
        let history = g.threads[pos].messages.clone();
        (provider, model, sys_prompt, history, ollama_url, lmstudio_url, active_account)
    };

    core.broadcast_snapshot(None);

    match run_ai_chat(&provider, &model, &sys_prompt, &history, &ollama_url, &lmstudio_url, &active_account).await {
        Ok((reply_text, thinking, used_model, token_count)) => {
            {
                let mut g = core.inner.lock().unwrap();
                g.record_ai_request(&active_account, token_count, false, None);
                if let Some(th) = g.threads.iter_mut().find(|t| t.id == req.thread_id) {
                    th.messages.push(ChatMessage {
                        id: uuid::Uuid::new_v4().to_string(),
                        role: "assistant".into(),
                        content: reply_text.clone(),
                        thinking,
                        provider: Some(provider),
                        model: Some(used_model),
                        image_data_url: None,
                        attached_file: None,
                        timestamp: chrono::Utc::now().to_rfc3339(),
                    });
                    th.updated_at = chrono::Utc::now().to_rfc3339();
                }
            }
            core.persist();
            core.broadcast_snapshot(Some("step"));
            (StatusCode::OK, Json(json!({ "ok": true, "reply": reply_text })))
        }
        Err(err) => {
            {
                let mut g = core.inner.lock().unwrap();
                let is_429 = err.contains("429");
                g.record_ai_request(&active_account, None, is_429, Some(err.clone()));
                if let Some(th) = g.threads.iter_mut().find(|t| t.id == req.thread_id) {
                    th.messages.push(ChatMessage {
                        id: uuid::Uuid::new_v4().to_string(),
                        role: "assistant".into(),
                        content: format!("⚠️ **Provider Notice:** {err}"),
                        thinking: None,
                        provider: Some(provider),
                        model: Some(model),
                        image_data_url: None,
                        attached_file: None,
                        timestamp: chrono::Utc::now().to_rfc3339(),
                    });
                }
            }
            core.persist();
            core.broadcast_snapshot(None);
            (StatusCode::OK, Json(json!({ "ok": false, "error": err })))
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct NewThreadReq {
    persona_id: Option<String>,
}

async fn api_chat_new(State(core): State<AppCore>, Json(req): Json<NewThreadReq>) -> Json<Value> {
    let id = format!("thread-{}", uuid::Uuid::new_v4());
    let thread = ChatThread {
        id: id.clone(),
        title: "New NOVA Thread".into(),
        persona_id: req.persona_id.unwrap_or_else(|| "architect".into()),
        messages: Vec::new(),
        updated_at: chrono::Utc::now().to_rfc3339(),
    };
    core.inner.lock().unwrap().threads.insert(0, thread);
    core.persist();
    core.broadcast_snapshot(None);
    Json(json!({ "ok": true, "threadId": id }))
}

async fn api_chat_delete(State(core): State<AppCore>, Json(req): Json<IdReq>) -> Json<Value> {
    core.inner
        .lock()
        .unwrap()
        .threads
        .retain(|t| t.id != req.id);
    core.persist();
    core.broadcast_snapshot(None);
    Json(json!({ "ok": true }))
}

async fn api_screen_snip() -> impl IntoResponse {
    match tokio::task::spawn_blocking(capture_screen_data_url)
        .await
        .map_err(|e| e.to_string())
        .and_then(|r| r)
    {
        Ok(data_url) => (StatusCode::OK, Json(json!({ "ok": true, "dataUrl": data_url }))),
        Err(e) => (StatusCode::BAD_REQUEST, Json(json!({ "ok": false, "error": e }))),
    }
}

async fn api_clipboard_image() -> impl IntoResponse {
    match tokio::task::spawn_blocking(read_clipboard_image_data_url)
        .await
        .map_err(|e| e.to_string())
        .and_then(|r| r)
    {
        Ok(Some((data_url, name))) => (
            StatusCode::OK,
            Json(json!({ "ok": true, "dataUrl": data_url, "name": name })),
        ),
        Ok(None) => (StatusCode::OK, Json(json!({ "ok": false }))),
        Err(e) => (StatusCode::BAD_REQUEST, Json(json!({ "ok": false, "error": e }))),
    }
}

#[derive(Deserialize)]
struct TextReq {
    text: String,
}

async fn api_clipboard_copy(Json(req): Json<TextReq>) -> impl IntoResponse {
    match write_clipboard_text(&req.text) {
        Ok(()) => (StatusCode::OK, Json(json!({ "ok": true }))),
        Err(e) => (StatusCode::BAD_REQUEST, Json(json!({ "ok": false, "error": e }))),
    }
}

async fn api_clipboard_pin(State(core): State<AppCore>, Json(req): Json<IdReq>) -> Json<Value> {
    {
        let mut g = core.inner.lock().unwrap();
        if let Some(entry) = g.clipboard_history.iter_mut().find(|c| c.id == req.id) {
            entry.pinned = !entry.pinned;
        }
    }
    core.broadcast_snapshot(None);
    Json(json!({ "ok": true }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FocusSessionReq {
    conversation_id: String,
}

async fn api_focus_session(
    State(core): State<AppCore>,
    Json(req): Json<FocusSessionReq>,
) -> impl IntoResponse {
    let target = {
        let g = core.inner.lock().unwrap();
        g.sessions
            .iter()
            .find(|s| s.conversation_id == req.conversation_id)
            .map(|s| (s.process_chain.clone(), s.workspace_path.clone()))
    };
    let Some((chain, ws)) = target else {
        return (
            StatusCode::NOT_FOUND,
            Json(json!({ "ok": false, "error": "Session not found" })),
        );
    };
    match tokio::task::spawn_blocking(move || focus_session_window(&chain, &ws))
        .await
        .map_err(|e| e.to_string())
        .and_then(|r| r)
    {
        Ok(msg) => (StatusCode::OK, Json(json!({ "ok": true, "message": msg }))),
        Err(e) => (StatusCode::BAD_REQUEST, Json(json!({ "ok": false, "error": e }))),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct OpenEditorReq {
    file_path: String,
    line: Option<u32>,
    editor: Option<String>,
    workspace_path: Option<String>,
}

async fn api_open_editor(Json(req): Json<OpenEditorReq>) -> impl IntoResponse {
    match open_in_editor(
        &req.file_path,
        req.line,
        req.editor.as_deref(),
        req.workspace_path.as_deref(),
    ) {
        Ok(msg) => (StatusCode::OK, Json(json!({ "ok": true, "message": msg }))),
        Err(e) => (StatusCode::BAD_REQUEST, Json(json!({ "ok": false, "error": e }))),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LaunchSessionReq {
    workspace_path: String,
    agent_cli: String,
    initial_prompt: Option<String>,
}

async fn api_launch_session(Json(req): Json<LaunchSessionReq>) -> impl IntoResponse {
    match launch_workspace_session(
        &req.workspace_path,
        &req.agent_cli,
        req.initial_prompt.as_deref(),
    ) {
        Ok(msg) => (StatusCode::OK, Json(json!({ "ok": true, "message": msg }))),
        Err(e) => (StatusCode::BAD_REQUEST, Json(json!({ "ok": false, "error": e }))),
    }
}

#[derive(Deserialize)]
struct UrlReq {
    url: String,
}

async fn api_open_url(Json(req): Json<UrlReq>) -> impl IntoResponse {
    match open_url_or_path(&req.url) {
        Ok(()) => (StatusCode::OK, Json(json!({ "ok": true }))),
        Err(e) => (StatusCode::BAD_REQUEST, Json(json!({ "ok": false, "error": e }))),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FocusTimerReq {
    action: String, // "start" | "pause" | "reset" | "set_mode"
    mode: Option<String>,
    goal: Option<String>,
}

async fn api_focus_control(
    State(core): State<AppCore>,
    Json(req): Json<FocusTimerReq>,
) -> Json<Value> {
    {
        let mut g = core.inner.lock().unwrap();
        if let Some(goal) = req.goal {
            g.focus.current_goal = goal;
        }
        match req.action.as_str() {
            "start" => g.focus.running = true,
            "pause" => g.focus.running = false,
            "reset" => {
                g.focus.running = false;
                g.focus.remaining_sec = g.focus.total_sec;
            }
            "set_mode" => {
                let m = req.mode.unwrap_or_else(|| "focus".into());
                let secs = match m.as_str() {
                    "short_break" => 5 * 60,
                    "long_break" => 15 * 60,
                    _ => 25 * 60,
                };
                g.focus.running = false;
                g.focus.mode = m;
                g.focus.total_sec = secs;
                g.focus.remaining_sec = secs;
            }
            _ => {}
        }
    }
    core.persist();
    core.broadcast_snapshot(None);
    Json(json!({ "ok": true }))
}

async fn api_focus_todos(
    State(core): State<AppCore>,
    Json(todos): Json<Vec<TodoItem>>,
) -> Json<Value> {
    core.inner.lock().unwrap().focus.todos = todos;
    core.persist();
    core.broadcast_snapshot(None);
    Json(json!({ "ok": true }))
}

async fn api_focus_scratchpad(
    State(core): State<AppCore>,
    Json(req): Json<TextReq>,
) -> Json<Value> {
    core.inner.lock().unwrap().focus.scratchpad_markdown = req.text;
    core.persist();
    Json(json!({ "ok": true }))
}

async fn api_voice_transcribe(
    State(core): State<AppCore>,
    mut multipart: Multipart,
) -> impl IntoResponse {
    let mut audio_bytes = Vec::new();
    let mut mime_type = "audio/webm".to_string();
    let mut auto_paste = false;

    while let Ok(Some(field)) = multipart.next_field().await {
        let name = field.name().unwrap_or_default().to_string();
        if name == "file" {
            if let Some(ct) = field.content_type() {
                mime_type = ct.to_string();
            }
            if let Ok(bytes) = field.bytes().await {
                audio_bytes = bytes.to_vec();
            }
        } else if name == "autoPaste" {
            if let Ok(txt) = field.text().await {
                auto_paste = txt == "true";
            }
        }
    }

    if audio_bytes.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "ok": false, "error": "Empty audio capture" })),
        );
    }

    let (stt_provider, dict, snippets) = {
        let g = core.inner.lock().unwrap();
        (
            g.settings.stt_provider.clone(),
            g.tech_dictionary.clone(),
            g.voice_snippets.clone(),
        )
    };

    match transcribe_audio_bytes(&stt_provider, audio_bytes, &mime_type, &dict).await {
        Ok(raw) => {
            let processed = post_process_transcript(&raw, &dict, &snippets);
            let words = processed.split_whitespace().count();
            {
                let mut g = core.inner.lock().unwrap();
                g.analytics.dictations_count += 1;
                g.analytics.dictated_words += words;
            }
            if auto_paste && !processed.is_empty() {
                let to_paste = processed.clone();
                let _ = tokio::task::spawn_blocking(move || paste_preserving_clipboard(&to_paste)).await;
            }
            core.persist();
            core.broadcast_snapshot(Some("ready"));
            (
                StatusCode::OK,
                Json(json!({ "ok": true, "raw": raw, "text": processed })),
            )
        }
        Err(e) => (StatusCode::BAD_REQUEST, Json(json!({ "ok": false, "error": e }))),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProcessVoiceTextReq {
    raw_text: String,
    auto_paste: bool,
}

async fn api_voice_process_text(
    State(core): State<AppCore>,
    Json(req): Json<ProcessVoiceTextReq>,
) -> Json<Value> {
    let processed = {
        let mut g = core.inner.lock().unwrap();
        let out = post_process_transcript(&req.raw_text, &g.tech_dictionary, &g.voice_snippets);
        g.analytics.dictations_count += 1;
        g.analytics.dictated_words += out.split_whitespace().count();
        out
    };
    if req.auto_paste && !processed.is_empty() {
        let to_paste = processed.clone();
        let _ = tokio::task::spawn_blocking(move || paste_preserving_clipboard(&to_paste)).await;
    }
    core.persist();
    core.broadcast_snapshot(Some("ready"));
    Json(json!({ "ok": true, "text": processed }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SaveVoiceNoteReq {
    title: String,
    mode: String,
    transcript: String,
    duration_sec: u64,
}

async fn api_voice_save_note(
    State(core): State<AppCore>,
    Json(req): Json<SaveVoiceNoteReq>,
) -> Json<Value> {
    let (lang, provider, model, ollama_url, lmstudio_url, active_account) = {
        let g = core.inner.lock().unwrap();
        (
            g.settings.language.clone(),
            g.settings.default_chat_provider.clone(),
            g.settings.default_chat_model.clone(),
            g.settings.ollama_url.clone(),
            g.settings.lmstudio_url.clone(),
            g.settings.active_account.clone(),
        )
    };

    let note = summarize_voice_note(
        &req.title,
        &req.mode,
        &lang,
        &req.transcript,
        req.duration_sec,
        &provider,
        &model,
        &ollama_url,
        &lmstudio_url,
        &active_account,
    )
    .await;

    core.inner.lock().unwrap().voice_notes.insert(0, note.clone());
    core.persist();
    core.broadcast_snapshot(Some("ready"));
    Json(json!({ "ok": true, "note": note }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ToggleNoteActionReq {
    note_id: String,
    action_id: String,
}

async fn api_voice_toggle_action(
    State(core): State<AppCore>,
    Json(req): Json<ToggleNoteActionReq>,
) -> Json<Value> {
    {
        let mut g = core.inner.lock().unwrap();
        if let Some(note) = g.voice_notes.iter_mut().find(|n| n.id == req.note_id) {
            if let Some(act) = note.action_items.iter_mut().find(|a| a.id == req.action_id) {
                act.done = !act.done;
            }
        }
    }
    core.persist();
    core.broadcast_snapshot(None);
    Json(json!({ "ok": true }))
}

async fn api_save_dictionary(
    State(core): State<AppCore>,
    Json(terms): Json<Vec<TechTerm>>,
) -> Json<Value> {
    core.inner.lock().unwrap().tech_dictionary = terms;
    core.persist();
    core.broadcast_snapshot(None);
    Json(json!({ "ok": true }))
}

async fn api_save_snippets(
    State(core): State<AppCore>,
    Json(snippets): Json<Vec<VoiceSnippet>>,
) -> Json<Value> {
    core.inner.lock().unwrap().voice_snippets = snippets;
    core.persist();
    core.broadcast_snapshot(None);
    Json(json!({ "ok": true }))
}

async fn api_export_devlog(State(core): State<AppCore>) -> Json<Value> {
    Json(json!({ "ok": true, "markdown": core.generate_devlog_markdown() }))
}

#[derive(Deserialize)]
struct WsQuery {
    token: Option<String>,
}

async fn ws_handler(
    ws: WebSocketUpgrade,
    State(core): State<AppCore>,
    Extension(scope): Extension<AuthScope>,
    Query(q): Query<WsQuery>,
) -> impl IntoResponse {
    let _ = q.token;
    ws.on_upgrade(move |socket| handle_ws_client(socket, core, scope))
}

async fn handle_ws_client(socket: WebSocket, core: AppCore, scope: AuthScope) {
    let (mut sender, mut receiver) = socket.split();
    let mut rx = core.events_tx.subscribe();

    // Immediately send initial snapshot on connect (redacted for MobileCompanion)
    let initial = json!({
        "type": "snapshot",
        "sound": null,
        "data": snapshot_for_scope(&core, scope)
    });
    if let Ok(txt) = serde_json::to_string(&initial) {
        let _ = sender.send(Message::Text(txt.into())).await;
    }

    let send_task = tokio::spawn(async move {
        while let Ok(mut ev) = rx.recv().await {
            if scope == AuthScope::MobileCompanion {
                if let Some(mobile_obj) = ev
                    .get_mut("data")
                    .and_then(|d| d.get_mut("mobile"))
                    .and_then(|m| m.as_object_mut())
                {
                    mobile_obj.insert("pairingToken".into(), Value::String(String::new()));
                    mobile_obj.insert("qrSvg".into(), Value::String(String::new()));
                }
            }
            if let Ok(txt) = serde_json::to_string(&ev) {
                if sender.send(Message::Text(txt.into())).await.is_err() {
                    break;
                }
            }
        }
    });

    while let Some(Ok(msg)) = receiver.next().await {
        if matches!(msg, Message::Close(_)) {
            break;
        }
    }

    send_task.abort();
}
