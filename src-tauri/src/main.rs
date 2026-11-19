#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod reports;
use tauri::{
    image::Image,
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    webview::NewWindowResponse,
    AppHandle, Manager, PhysicalPosition, PhysicalSize, Rect, WebviewWindow, WebviewWindowBuilder,
};

#[tauri::command]
fn hide(window: WebviewWindow) -> Result<(), String> {
    window.hide().map_err(|e| e.to_string())
}

#[tauri::command]
fn open_external(url: String) -> Result<(), String> {
    if url != "https://chatgpt.com/#settings/Usage" {
        return Err("Unknown usage settings address".into());
    }
    open::that(url).map_err(|e| e.to_string())
}

fn anchor(window: &WebviewWindow, rect: Option<Rect>) -> tauri::Result<()> {
    let cursor = window.cursor_position()?;
    let Some(monitor) = window.monitor_from_point(cursor.x, cursor.y)? else {
        return Ok(());
    };
    let area = monitor.work_area();
    let scale = monitor.scale_factor();
    let (point, icon) = rect
        .map(|r| {
            (
                r.position.to_physical::<i32>(scale),
                r.size.to_physical::<u32>(scale),
            )
        })
        .filter(|(_, size)| size.width > 0)
        .unwrap_or((cursor.cast(), PhysicalSize::new(1, 1)));
    let old = window.outer_size()?;
    let width = old.width.min(area.size.width);
    let height = old.height.min(area.size.height);
    let gap = (6.0 * scale).round() as i32;
    let x = point.x + (icon.width as i32 - width as i32) / 2;
    let above = point.y - height as i32 - gap;
    let y = if above >= area.position.y {
        above
    } else {
        point.y + icon.height as i32 + gap
    };
    if old.width != width || old.height != height {
        window.set_size(PhysicalSize::new(width, height))?;
    }
    window.set_position(PhysicalPosition::new(
        x.clamp(
            area.position.x,
            area.position.x + (area.size.width - width) as i32,
        ),
        y.clamp(
            area.position.y,
            area.position.y + (area.size.height - height) as i32,
        ),
    ))
}

fn show(app: &AppHandle, rect: Option<Rect>) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = anchor(&window, rect);
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            show(app, None)
        }))
        .manage(reports::Reports::default())
        .invoke_handler(tauri::generate_handler![
            reports::environments,
            reports::report,
            hide,
            open_external
        ])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .setup(|app| {
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);
            WebviewWindowBuilder::from_config(app, &app.config().app.windows[0])?
                .on_navigation(|url| {
                    matches!(
                        (url.scheme(), url.host_str()),
                        ("tauri", Some("localhost")) | ("http" | "https", Some("tauri.localhost"))
                    )
                })
                .on_new_window(|_, _| NewWindowResponse::Deny)
                .build()?;
            let open = MenuItem::with_id(app, "open", "Open ModelGauge", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit ModelGauge", true, None::<&str>)?;
            let menu =
                Menu::with_items(app, &[&open, &PredefinedMenuItem::separator(app)?, &quit])?;
            let bytes: &[u8] = if cfg!(target_os = "macos") {
                include_bytes!("../../assets/trayTemplate.png")
            } else {
                include_bytes!("../../assets/tray.png")
            };
            let tray = TrayIconBuilder::with_id("gauge")
                .icon(Image::from_bytes(bytes)?)
                .icon_as_template(cfg!(target_os = "macos"))
                .tooltip("ModelGauge · Model usage")
                .menu(&menu)
                .show_menu_on_left_click(cfg!(target_os = "linux"))
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "open" => show(
                        app,
                        app.tray_by_id("gauge")
                            .and_then(|t| t.rect().ok().flatten()),
                    ),
                    "quit" => app.exit(0),
                    _ => (),
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        rect,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        if let Some(window) = app.get_webview_window("main") {
                            if window.is_visible().unwrap_or(false) {
                                let _ = window.hide();
                            } else {
                                show(app, Some(rect));
                            }
                        }
                    }
                })
                .build(app)?;
            if !std::env::args_os().any(|arg| arg == "--tray") {
                show(app.handle(), tray.rect().ok().flatten());
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("Could not start ModelGauge");
}
