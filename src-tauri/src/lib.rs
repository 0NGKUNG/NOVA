pub mod agy_hooks;
pub mod ai_services;
pub mod models;
pub mod risk;
pub mod server;
pub mod state;
pub mod system_tools;

use serde::Serialize;
use state::AppCore;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, PhysicalPosition, PhysicalSize,
    State, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
};

/// Constant transparent stage size so NOVA never resizes its Win32/WebView2 swapchain
/// during expand or collapse — completely eliminating start/end DWM resize shutter!
pub const STAGE_W: f64 = 900.0;
pub const STAGE_H: f64 = 620.0;
const NEAR_ZONE_PX: f64 = 240.0;

#[derive(Clone, Copy, Debug, Default)]
pub struct IslandHitRect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

#[derive(Clone, Copy, Debug)]
pub struct CachedWindowOrigin {
    pub px: f64,
    pub py: f64,
    pub scale: f64,
}

#[derive(Clone, Copy, Serialize)]
pub struct IslandPointerEvent {
    pub inside: bool,
    pub x: f64,
    pub y: f64,
}

pub struct IslandStageState {
    pub is_expanded: AtomicBool,
    pub rect: Mutex<IslandHitRect>,
    pub win_origin: Mutex<CachedWindowOrigin>,
    pub ignoring: AtomicBool,
    pub last_zone: Mutex<String>,
    pub last_monitor: AtomicUsize,
}

impl IslandStageState {
    pub fn new(zone: String, monitor_index: usize) -> Self {
        let init_w = 168.0;
        let init_h = 38.0;
        let init_rect = match zone.as_str() {
            "top-left" => IslandHitRect {
                x: 16.0,
                y: 8.0,
                w: init_w,
                h: init_h,
            },
            "top-right" => IslandHitRect {
                x: STAGE_W - init_w - 16.0,
                y: 8.0,
                w: init_w,
                h: init_h,
            },
            "bottom-dock" => IslandHitRect {
                x: (STAGE_W - init_w) * 0.5,
                y: STAGE_H - init_h - 14.0,
                w: init_w,
                h: init_h,
            },
            _ => IslandHitRect {
                x: (STAGE_W - init_w) * 0.5,
                y: 8.0,
                w: init_w,
                h: init_h,
            },
        };

        Self {
            is_expanded: AtomicBool::new(false),
            rect: Mutex::new(init_rect),
            win_origin: Mutex::new(CachedWindowOrigin {
                px: 0.0,
                py: 0.0,
                scale: 1.0,
            }),
            ignoring: AtomicBool::new(true),
            last_zone: Mutex::new(zone),
            last_monitor: AtomicUsize::new(monitor_index),
        }
    }
}

fn atomic_set_window_bounds(win: &WebviewWindow, px: i32, py: i32, pw: i32, ph: i32) {
    #[cfg(windows)]
    {
        use windows::Win32::Foundation::HWND;
        use windows::Win32::UI::WindowsAndMessaging::{
            SetWindowPos, HWND_TOPMOST, SWP_NOACTIVATE, SWP_SHOWWINDOW,
        };
        if let Ok(raw_hwnd) = win.hwnd() {
            let hwnd = HWND(raw_hwnd.0 as *mut core::ffi::c_void);
            unsafe {
                let _ = SetWindowPos(
                    hwnd,
                    HWND_TOPMOST,
                    px,
                    py,
                    pw.max(1),
                    ph.max(1),
                    SWP_NOACTIVATE | SWP_SHOWWINDOW,
                );
            }
            return;
        }
    }

    let _ = win.set_size(PhysicalSize::new(pw.max(1) as u32, ph.max(1) as u32));
    let _ = win.set_position(PhysicalPosition::new(px, py));
    let _ = win.show();
}

#[cfg(windows)]
fn cursor_physical() -> Option<(f64, f64)> {
    use windows::Win32::Foundation::POINT;
    use windows::Win32::UI::WindowsAndMessaging::GetCursorPos;

    unsafe {
        let mut pt = POINT::default();
        if GetCursorPos(&mut pt).is_ok() {
            return Some((pt.x as f64, pt.y as f64));
        }
    }
    None
}

#[cfg(not(windows))]
fn cursor_physical() -> Option<(f64, f64)> {
    None
}

/// Adaptive zero-overhead Win32 cursor hit-tester (mirrors Coucou's `island.rs` architecture):
/// Keeps the transparent 900×620 window 100% click-through (`WS_EX_TRANSPARENT`) everywhere
/// outside the live animated pill/island silhouette (`rect ± margin`), so the OS window never
/// needs to resize on expand or collapse.
fn spawn_island_hit_tester(app: AppHandle, stage: Arc<IslandStageState>) {
    std::thread::spawn(move || {
        let mut was_inside: Option<bool> = None;
        let mut ticks: u32 = 0;
        let mut sleep_ms: u64 = 32;
        let mut last_folded_hover_sync = Instant::now();
        let mut last_pointer_emit = Instant::now();
        let mut last_phys: (f64, f64) = (f64::MIN, f64::MIN);
        let mut last_cursor_move = Instant::now();

        loop {
            std::thread::sleep(Duration::from_millis(sleep_ms));

            // Periodically sync window physical origin in case of display hotplug or free-mode drag
            ticks = ticks.wrapping_add(1);
            if ticks % 45 == 0 {
                if let Some(win) = app.get_webview_window("island") {
                    if let Ok(origin) = win.outer_position() {
                        let scale = win.scale_factor().unwrap_or(1.0).max(0.25);
                        *stage.win_origin.lock().unwrap() = CachedWindowOrigin {
                            px: origin.x as f64,
                            py: origin.y as f64,
                            scale,
                        };
                    }
                }
            }

            let Some((cx, cy)) = cursor_physical() else {
                sleep_ms = 50;
                continue;
            };

            let cursor_moved = (cx - last_phys.0).abs() >= 1.0 || (cy - last_phys.1).abs() >= 1.0;
            if cursor_moved {
                last_phys = (cx, cy);
                last_cursor_move = Instant::now();
            }

            let origin = *stage.win_origin.lock().unwrap();
            let lx = (cx - origin.px) / origin.scale;
            let ly = (cy - origin.py) / origin.scale;

            let r = *stage.rect.lock().unwrap();
            let on_island = r.w > 0.0
                && lx >= r.x
                && lx <= r.x + r.w
                && ly >= r.y
                && ly <= r.y + r.h;

            let near_island = lx >= r.x - NEAR_ZONE_PX
                && lx <= r.x + r.w + NEAR_ZONE_PX
                && ly >= r.y - NEAR_ZONE_PX
                && ly <= r.y + r.h + NEAR_ZONE_PX;

            let active_motion = last_cursor_move.elapsed() < Duration::from_millis(320);
            sleep_ms = if on_island || near_island || active_motion {
                14
            } else {
                40
            };

            let should_ignore = !on_island;
            if stage.ignoring.swap(should_ignore, Ordering::Relaxed) != should_ignore {
                if let Some(win) = app.get_webview_window("island") {
                    let _ = win.set_ignore_cursor_events(should_ignore);
                }
            }

            // Pointer transitions can be swallowed while Windows toggles the
            // transparent stage's click-through style. While folded, send a
            // low-rate hover heartbeat so the UI can recover its hover state.
            let folded_hover_sync = on_island
                && !stage.is_expanded.load(Ordering::Relaxed)
                && last_folded_hover_sync.elapsed() >= Duration::from_millis(180);
            if folded_hover_sync {
                last_folded_hover_sync = Instant::now();
            }

            // Stream ~60 Hz cursor coordinates across the entire screen whenever the
            // pointer moves (zero events when stationary!) so NOVA's eyes track the
            // cursor everywhere just like Coucou, even while click-through is active.
            let pointer_tracking =
                cursor_moved && last_pointer_emit.elapsed() >= Duration::from_millis(15);
            if pointer_tracking {
                last_pointer_emit = Instant::now();
            }

            let pointer_transition = was_inside != Some(on_island);
            if pointer_transition {
                was_inside = Some(on_island);
            }
            if pointer_transition || folded_hover_sync || pointer_tracking {
                if let Some(win) = app.get_webview_window("island") {
                    if pointer_transition && on_island {
                        // Reassert the configured topmost level when the user approaches NOVA.
                        let _ = win.set_always_on_top(true);
                    }
                    let _ = win.emit(
                        "nova-island-pointer",
                        IslandPointerEvent {
                            inside: on_island,
                            x: lx,
                            y: ly,
                        },
                    );
                }

                // Also feed the Detached Desktop Orb window if visible
                if pointer_tracking {
                    if let Some(orb_win) = app.get_webview_window("orb") {
                        if orb_win.is_visible().unwrap_or(false) {
                            if let Ok(orb_pos) = orb_win.outer_position() {
                                let orb_scale = orb_win.scale_factor().unwrap_or(1.0).max(0.25);
                                let ox = (cx - orb_pos.x as f64) / orb_scale;
                                let oy = (cy - orb_pos.y as f64) / orb_scale;
                                let _ = orb_win.emit(
                                    "nova-island-pointer",
                                    IslandPointerEvent {
                                        inside: false,
                                        x: ox,
                                        y: oy,
                                    },
                                );
                            }
                        }
                    }
                }
            }
        }
    });
}

#[tauri::command]
fn set_island_passthrough(
    app: AppHandle,
    stage: State<'_, Arc<IslandStageState>>,
    ignore: bool,
) -> Result<(), String> {
    if let Some(win) = app.get_webview_window("island") {
        stage.ignoring.store(ignore, Ordering::Relaxed);
        win.set_ignore_cursor_events(ignore)
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn set_island_rect(
    stage: State<'_, Arc<IslandStageState>>,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
) -> Result<(), String> {
    if x.is_finite() && y.is_finite() && w.is_finite() && h.is_finite() {
        *stage.rect.lock().unwrap() = IslandHitRect { x, y, w, h };
    }
    Ok(())
}

fn place_stage_window(
    app: &AppHandle,
    stage: &Arc<IslandStageState>,
    zone: &str,
    monitor_index: usize,
) -> Result<(), String> {
    let Some(win) = app.get_webview_window("island") else {
        return Ok(());
    };

    if zone == "free" {
        let scale = win.scale_factor().unwrap_or(1.0).max(0.25);
        let pw = (((STAGE_W * scale).round() as i32) + 1) & !1;
        let ph = (STAGE_H * scale).round() as i32;
        if let Ok(pos) = win.outer_position() {
            atomic_set_window_bounds(&win, pos.x, pos.y, pw, ph);
            *stage.win_origin.lock().unwrap() = CachedWindowOrigin {
                px: pos.x as f64,
                py: pos.y as f64,
                scale,
            };
        } else {
            let _ = win.set_size(LogicalSize::new(STAGE_W, STAGE_H));
            let _ = win.show();
        }
        return Ok(());
    }

    let monitors = win.available_monitors().map_err(|e| e.to_string())?;
    let mon = monitors
        .get(monitor_index)
        .or_else(|| monitors.first())
        .cloned();

    let Some(mon) = mon else {
        return Ok(());
    };

    let scale = mon.scale_factor().max(0.25);
    let mon_pos = mon.position();
    let mon_size = mon.size();

    let top_inset = {
        let inset = mon.work_area().position.y - mon_pos.y;
        if (0..200).contains(&inset) {
            inset
        } else {
            0
        }
    };

    let pw = (((STAGE_W * scale).round() as i32) + 1) & !1;
    let ph = (STAGE_H * scale).round() as i32;
    let pad_edge = (8.0 * scale).round() as i32;
    let pad_top = (2.0 * scale).round() as i32 + top_inset;
    let pad_bottom_dock = (46.0 * scale).round() as i32;

    let (px, py) = match zone {
        "top-left" => (mon_pos.x + pad_edge, mon_pos.y + pad_top),
        "top-right" => (
            mon_pos.x + (mon_size.width as i32) - pw - pad_edge,
            mon_pos.y + pad_top,
        ),
        "bottom-dock" => (
            mon_pos.x + ((mon_size.width as i32) - pw) / 2,
            mon_pos.y + (mon_size.height as i32) - ph - pad_bottom_dock,
        ),
        _ => (
            mon_pos.x + ((mon_size.width as i32) - pw) / 2,
            mon_pos.y + pad_top,
        ),
    };

    *stage.win_origin.lock().unwrap() = CachedWindowOrigin {
        px: px as f64,
        py: py as f64,
        scale,
    };

    atomic_set_window_bounds(&win, px, py, pw, ph);
    let _ = win.show();
    Ok(())
}

#[tauri::command]
fn apply_snap_zone(
    app: AppHandle,
    stage: State<'_, Arc<IslandStageState>>,
    zone: Option<String>,
    monitor_index: Option<usize>,
    expanded: Option<bool>,
    _folded_w: Option<f64>,
    _folded_h: Option<f64>,
) -> Result<(), String> {
    if let Some(exp) = expanded {
        stage.is_expanded.store(exp, Ordering::Relaxed);
    }

    let mut zone_or_mon_changed = false;
    let resolved_zone = if let Some(z) = zone {
        let mut prev = stage.last_zone.lock().unwrap();
        if *prev != z {
            *prev = z.clone();
            zone_or_mon_changed = true;
        }
        z
    } else {
        stage.last_zone.lock().unwrap().clone()
    };

    let resolved_mon = if let Some(mi) = monitor_index {
        let prev = stage.last_monitor.swap(mi, Ordering::Relaxed);
        if prev != mi {
            zone_or_mon_changed = true;
        }
        mi
    } else {
        stage.last_monitor.load(Ordering::Relaxed)
    };

    // Only call SetWindowPos when the monitor or snapZone actually changes — NEVER on expand/collapse!
    if zone_or_mon_changed || expanded.is_none() {
        place_stage_window(&app, &stage, &resolved_zone, resolved_mon)?;
    }

    Ok(())
}

#[tauri::command]
fn toggle_detached_orb(app: AppHandle, visible: bool) -> Result<(), String> {
    if let Some(orb_win) = app.get_webview_window("orb") {
        if visible {
            let _ = orb_win.show();
            let _ = orb_win.set_focus();
        } else {
            let _ = orb_win.hide();
        }
        return Ok(());
    }

    if visible {
        let orb = WebviewWindowBuilder::new(
            &app,
            "orb",
            WebviewUrl::App("index.html?surface=orb".into()),
        )
        .title("NOVA Orb")
        .inner_size(240.0, 110.0)
        .resizable(false)
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .visible(true)
        .build()
        .map_err(|e| e.to_string())?;

        if let Ok(Some(primary)) = orb.primary_monitor() {
            let scale = primary.scale_factor();
            let size = primary.size();
            let mw = (size.width as f64) / scale;
            let mh = (size.height as f64) / scale;
            let _ = orb.set_position(LogicalPosition::new(mw - 268.0, mh - 176.0));
        }
    }
    Ok(())
}

#[tauri::command]
fn get_ipc_token(core: State<'_, AppCore>) -> String {
    core.inner.lock().unwrap().ipc_token.clone()
}

#[tauri::command]
fn focus_island_window(app: AppHandle, stage: State<'_, Arc<IslandStageState>>) -> Result<(), String> {
    if let Some(win) = app.get_webview_window("island") {
        stage.ignoring.store(false, Ordering::Relaxed);
        let _ = win.set_ignore_cursor_events(false);
        #[cfg(windows)]
        {
            use windows::Win32::Foundation::HWND;
            use windows::Win32::UI::WindowsAndMessaging::SetForegroundWindow;
            if let Ok(raw_hwnd) = win.hwnd() {
                let hwnd = HWND(raw_hwnd.0 as *mut core::ffi::c_void);
                unsafe {
                    let _ = SetForegroundWindow(hwnd);
                }
            }
        }
        let _ = win.set_focus();
    }
    Ok(())
}

#[tauri::command]
fn show_hub_window(app: AppHandle) -> Result<(), String> {
    if let Some(hub) = app.get_webview_window("hub") {
        let _ = hub.show();
        let _ = hub.unminimize();
        let _ = hub.set_focus();
        return Ok(());
    }

    let hub = WebviewWindowBuilder::new(
        &app,
        "hub",
        WebviewUrl::App("index.html?surface=hub".into()),
    )
    .title("NOVA — Mission Control & Hub")
    .inner_size(1220.0, 820.0)
    .min_inner_size(960.0, 660.0)
    .resizable(true)
    .decorations(true)
    .transparent(false)
    .center()
    .visible(true)
    .focused(true)
    .build()
    .map_err(|e| e.to_string())?;

    let _ = hub.set_focus();
    Ok(())
}

pub fn run_headless() {
    let rt = tokio::runtime::Runtime::new().expect("tokio runtime");
    rt.block_on(async {
        let core = AppCore::new();
        let _ = agy_hooks::sync_hook_binary();
        core.start_background_loops();
        println!(
            "NOVA Core Engine listening on http://127.0.0.1:{}",
            state::CORE_PORT
        );
        server::start_core_http_server(core, None).await;
    });
}

/// If NOVA is already running on localhost:47920, wake the existing Island and exit 0 cleanly
/// instead of crashing WebView2 with HRESULT 0x800700AA ("The requested resource is in use").
fn try_wake_existing_instance() {
    use std::io::{Read, Write};
    use std::net::{SocketAddr, TcpStream};

    let addr = SocketAddr::from(([127, 0, 0, 1], state::CORE_PORT));
    let Ok(mut stream) = TcpStream::connect_timeout(&addr, Duration::from_millis(220)) else {
        return;
    };

    let token_path = agy_hooks::nova_data_dir().join("ipc.token");
    let token = std::fs::read_to_string(token_path)
        .map(|s| s.trim().to_string())
        .unwrap_or_default();

    let _ = stream.set_write_timeout(Some(Duration::from_millis(300)));
    let _ = stream.set_read_timeout(Some(Duration::from_millis(300)));
    let req = format!(
        "POST /api/window/wake HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nContent-Type: application/json\r\nX-Nova-Token: {token}\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{{}}",
        state::CORE_PORT
    );
    let _ = stream.write_all(req.as_bytes());
    let mut buf = [0u8; 128];
    let _ = stream.read(&mut buf);
}

pub fn run() {
    if std::env::args().any(|a| a == "--headless") {
        run_headless();
        return;
    }

    let core = AppCore::new();
    let bind_all = core.inner.lock().unwrap().settings.remote_lan_enabled;
    let bind_addr = if bind_all {
        std::net::SocketAddr::from(([0, 0, 0, 0], state::CORE_PORT))
    } else {
        std::net::SocketAddr::from(([127, 0, 0, 1], state::CORE_PORT))
    };

    // Kernel-atomic single-instance lock BEFORE initializing WebView2
    let Ok(prebound_listener) = std::net::TcpListener::bind(bind_addr) else {
        try_wake_existing_instance();
        return;
    };
    let prebound_slot = Arc::new(Mutex::new(Some(prebound_listener)));
    let _ = agy_hooks::sync_hook_binary();

    let boot_zone = core.inner.lock().unwrap().settings.snap_zone.clone();
    let boot_mon = core.inner.lock().unwrap().settings.monitor_index;
    let boot_orb = core.inner.lock().unwrap().settings.detached_orb_visible;
    let stage_state = Arc::new(IslandStageState::new(boot_zone.clone(), boot_mon));

    tauri::Builder::default()
        .manage(core.clone())
        .manage(stage_state.clone())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--minimized"]),
        ))
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            set_island_passthrough,
            set_island_rect,
            apply_snap_zone,
            toggle_detached_orb,
            get_ipc_token,
            focus_island_window,
            show_hub_window,
        ])
        .setup(move |app| {
            let server_core = core.clone();
            let wake_handle = app.handle().clone();
            let wake_stage = stage_state.clone();
            let mut wake_rx = core.events_tx.subscribe();
            tauri::async_runtime::spawn(async move {
                while let Ok(ev) = wake_rx.recv().await {
                    if ev.get("type").and_then(|v| v.as_str()) == Some("window_wake") {
                        let zone = wake_stage.last_zone.lock().unwrap().clone();
                        let mon = wake_stage.last_monitor.load(Ordering::Relaxed);
                        let _ = place_stage_window(&wake_handle, &wake_stage, &zone, mon);
                        if let Some(w) = wake_handle.get_webview_window("island") {
                            let _ = w.show();
                        }
                    }
                }
            });

            let listener_for_srv = prebound_slot.lock().unwrap().take();
            tauri::async_runtime::spawn(async move {
                server_core.start_background_loops();
                server::start_core_http_server(server_core, listener_for_srv).await;
            });

            let handle = app.handle().clone();
            if let Some(win) = handle.get_webview_window("island") {
                let _ = win.set_ignore_cursor_events(true);
            }
            let _ = place_stage_window(&handle, &stage_state, &boot_zone, boot_mon);
            spawn_island_hit_tester(handle.clone(), stage_state.clone());

            if boot_orb {
                let _ = toggle_detached_orb(handle.clone(), true);
            }

            // Build Windows System Tray Menu
            let open_hub =
                MenuItem::with_id(app, "open_hub", "Open NOVA Command Hub", true, None::<&str>)?;
            let toggle_island =
                MenuItem::with_id(app, "toggle_island", "Show Dynamic Island", true, None::<&str>)?;
            let detach_orb = MenuItem::with_id(
                app,
                "detach_orb",
                "Toggle Desktop Floating Orb",
                true,
                None::<&str>,
            )?;
            let sep = PredefinedMenuItem::separator(app)?;
            let quit = MenuItem::with_id(app, "quit", "Quit NOVA", true, None::<&str>)?;
            let menu =
                Menu::with_items(app, &[&open_hub, &toggle_island, &detach_orb, &sep, &quit])?;

            if let Some(icon) = app.default_window_icon().cloned() {
                let _tray = TrayIconBuilder::new()
                    .icon(icon)
                    .tooltip("NOVA — AI Agent Mission Control")
                    .menu(&menu)
                    .on_menu_event(|app, ev| match ev.id().as_ref() {
                        "open_hub" => {
                            let _ = show_hub_window(app.clone());
                        }
                        "toggle_island" => {
                            if let Some(w) = app.get_webview_window("island") {
                                let _ = w.show();
                            }
                        }
                        "detach_orb" => {
                            let vis = app
                                .get_webview_window("orb")
                                .and_then(|w| w.is_visible().ok())
                                .unwrap_or(false);
                            let _ = toggle_detached_orb(app.clone(), !vis);
                        }
                        "quit" => {
                            app.exit(0);
                        }
                        _ => {}
                    })
                    .on_tray_icon_event(|tray, event| {
                        if let TrayIconEvent::Click {
                            button: MouseButton::Left,
                            button_state: MouseButtonState::Up,
                            ..
                        } = event
                        {
                            let _ = show_hub_window(tray.app_handle().clone());
                        }
                    })
                    .build(app)?;
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running NOVA Tauri application");
}
