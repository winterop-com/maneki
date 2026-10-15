//! Maneki desktop entrypoint.
//!
//! The Rust side stays minimal — it registers plugins, runs the Tauri
//! app, and persists the main window's outer bounds across launches.
//! The entire UI (login, shell, browse, playback) is owned by
//! `desktop/app/` — the TypeScript client, built with Vite into `dist/`.
//!
//! Window bounds persistence
//! -------------------------
//! `tauri-plugin-window-state` v2 had a macOS bug where Resized events
//! delivered during minimize / fullscreen exit carried sub-min sizes
//! (we saw 1780x106 restored as the new "remembered" size). Rather than
//! pull that plugin back in, we store a single `window.json` file in
//! `app_data_dir()` ourselves and gate every save on:
//!
//!   - `is_minimized()` is false
//!   - `is_fullscreen()` is false
//!   - the size is at or above the logical 720x480 min
//!
//! BOUNDS ARE KEPT IN POINTS, NOT PIXELS. A Retina laptop has two physical
//! pixels to the point and an external display often one, so a size saved
//! in pixels on the laptop came back twice as large on the display, wider
//! and taller than the screen, and a position saved against one arrangement
//! of screens could land off every screen of the next. A file from before
//! (`logical` missing) is not trusted and the default is used once.
//!
//! THE WINDOW ALWAYS FITS THE SCREEN IT IS ON. On startup the saved place is
//! used only on a screen that still exists (else the main screen, centred),
//! and the size and position are clamped to that screen's work area. The
//! same fit runs whenever the window changes scale factor -- moved to the
//! other screen, or the display it was on unplugged -- so it is never left
//! hanging past an edge it cannot be dragged back from.
//!
//! What we deliberately do NOT do:
//!
//!   - Auto-open DevTools. The user can press Cmd+Option+I (macOS)
//!     or right-click → Inspect Element when they want it. Auto-opening
//!     is jarring on every launch and the panel obscures the small
//!     login window.

use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::{LogicalPosition, LogicalSize, Manager, Monitor, WebviewWindow, WindowEvent};

const MIN_WIDTH_LOGICAL: f64 = 720.0;
const MIN_HEIGHT_LOGICAL: f64 = 480.0;

/// The window's inner size and outer position, in logical points.
#[derive(Serialize, Deserialize, Clone, Copy, Debug)]
struct WindowBounds {
    width: f64,
    height: f64,
    x: Option<f64>,
    y: Option<f64>,
    /// False for a file written in physical pixels by an older build.
    #[serde(default)]
    logical: bool,
}

/// A monitor's work area (the screen less menu bar and Dock) in logical points.
struct Area {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

fn area(monitor: &Monitor) -> Area {
    let scale = monitor.scale_factor();
    let rect = monitor.work_area();
    let pos = rect.position.to_logical::<f64>(scale);
    let size = rect.size.to_logical::<f64>(scale);
    Area {
        x: pos.x,
        y: pos.y,
        width: size.width,
        height: size.height,
    }
}

/// The work area holding the point, if any monitor does.
fn area_at(window: &WebviewWindow, x: f64, y: f64) -> Option<Area> {
    window
        .available_monitors()
        .ok()?
        .iter()
        .map(area)
        .find(|a| x >= a.x && x < a.x + a.width && y >= a.y && y < a.y + a.height)
}

/// Clamp a rectangle into an area: no larger than it, and inside it.
fn clamp(a: &Area, x: f64, y: f64, width: f64, height: f64) -> (f64, f64, f64, f64) {
    let width = width.min(a.width);
    let height = height.min(a.height);
    let x = x.max(a.x).min(a.x + a.width - width);
    let y = y.max(a.y).min(a.y + a.height - height);
    (x, y, width, height)
}

/// Shrink and move the window, if it must, so it sits wholly on the screen it is on.
fn fit(window: &WebviewWindow) {
    if window.is_fullscreen().unwrap_or(false) || window.is_minimized().unwrap_or(false) {
        return;
    }
    let Ok(scale) = window.scale_factor() else {
        return;
    };
    let (Ok(outer), Ok(inner), Ok(pos)) = (
        window.outer_size(),
        window.inner_size(),
        window.outer_position(),
    ) else {
        return;
    };
    let outer = outer.to_logical::<f64>(scale);
    let inner = inner.to_logical::<f64>(scale);
    let pos = pos.to_logical::<f64>(scale);
    let monitor = window
        .current_monitor()
        .ok()
        .flatten()
        .or_else(|| window.primary_monitor().ok().flatten());
    let Some(a) = monitor.as_ref().map(area) else {
        return;
    };
    let (x, y, width, height) = clamp(&a, pos.x, pos.y, outer.width, outer.height);
    if (width - outer.width).abs() > 0.5 || (height - outer.height).abs() > 0.5 {
        // Outer less inner is the frame; set_size sets the inner size.
        let _ = window.set_size(LogicalSize::new(
            width - (outer.width - inner.width),
            height - (outer.height - inner.height),
        ));
    }
    if (x - pos.x).abs() > 0.5 || (y - pos.y).abs() > 0.5 {
        let _ = window.set_position(LogicalPosition::new(x, y));
    }
}

fn bounds_path(app: &tauri::AppHandle) -> Option<PathBuf> {
    app.path()
        .app_data_dir()
        .ok()
        .map(|d| d.join("window.json"))
}

fn load_bounds(app: &tauri::AppHandle) -> Option<WindowBounds> {
    let path = bounds_path(app)?;
    let raw = fs::read_to_string(path).ok()?;
    serde_json::from_str(&raw).ok()
}

fn write_bounds(app: &tauri::AppHandle, bounds: &WindowBounds) {
    let Some(path) = bounds_path(app) else { return };
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if let Ok(json) = serde_json::to_string(bounds) {
        let _ = fs::write(path, json);
    }
}

// Fullscreen is driven from the JS side via Tauri 2's built-in
// `core:window:allow-set-fullscreen` permission - no custom invoke
// handler needed. See desktop/app/src/lib/desktop.ts.

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .invoke_handler(tauri::generate_handler![])
        .setup(|app| {
            let window = app.get_webview_window("main").expect("main window");

            if let Some(b) = load_bounds(app.handle()).filter(|b| {
                b.logical && b.width >= MIN_WIDTH_LOGICAL && b.height >= MIN_HEIGHT_LOGICAL
            }) {
                // The saved place counts only on a screen that is still there; on none,
                // the size is kept and the window is centred on the main screen.
                // Worked out from the saved numbers rather than read back after a set_size:
                // macOS applies a new size later, and a fit that read the window straight
                // away saw the old one and left a 3594-point window on a 2560 screen.
                let here = match (b.x, b.y) {
                    (Some(x), Some(y)) => area_at(&window, x + 40.0, y + 20.0).map(|a| (a, x, y)),
                    _ => None,
                };
                let placed = here
                    .map(|(a, x, y)| clamp(&a, x, y, b.width, b.height))
                    .or_else(|| {
                        let monitor = window
                            .current_monitor()
                            .ok()
                            .flatten()
                            .or_else(|| window.primary_monitor().ok().flatten())?;
                        let a = area(&monitor);
                        let (w, h) = (b.width.min(a.width), b.height.min(a.height));
                        Some((a.x + (a.width - w) / 2.0, a.y + (a.height - h) / 2.0, w, h))
                    });
                if let Some((x, y, w, h)) = placed {
                    let _ = window.set_size(LogicalSize::new(w, h));
                    let _ = window.set_position(LogicalPosition::new(x, y));
                }
            }
            fit(&window);

            let app_handle = app.handle().clone();
            let win = window.clone();
            window.on_window_event(move |event| {
                if matches!(event, WindowEvent::ScaleFactorChanged { .. }) {
                    // Onto another screen, or the screen it was on went away.
                    fit(&win);
                    return;
                }
                if !matches!(event, WindowEvent::Resized(_) | WindowEvent::Moved(_)) {
                    return;
                }
                if win.is_minimized().unwrap_or(false) {
                    return;
                }
                if win.is_fullscreen().unwrap_or(false) {
                    return;
                }
                let Ok(scale) = win.scale_factor() else {
                    return;
                };
                let Ok(size) = win.inner_size() else { return };
                let size = size.to_logical::<f64>(scale);
                if size.width < MIN_WIDTH_LOGICAL || size.height < MIN_HEIGHT_LOGICAL {
                    return;
                }
                let position = win
                    .outer_position()
                    .ok()
                    .map(|p| p.to_logical::<f64>(scale));
                write_bounds(
                    &app_handle,
                    &WindowBounds {
                        width: size.width,
                        height: size.height,
                        x: position.map(|p| p.x),
                        y: position.map(|p| p.y),
                        logical: true,
                    },
                );
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::{Area, WindowBounds, clamp};

    const LAPTOP: Area = Area {
        x: 0.0,
        y: 25.0,
        width: 1512.0,
        height: 920.0,
    };

    #[test]
    fn a_window_that_fits_stays_where_it_is() {
        assert_eq!(
            clamp(&LAPTOP, 100.0, 100.0, 1200.0, 800.0),
            (100.0, 100.0, 1200.0, 800.0)
        );
    }

    #[test]
    fn a_window_larger_than_the_screen_shrinks_to_it() {
        // 1797x1054 was what the bug left behind: wider and taller than the laptop.
        assert_eq!(
            clamp(&LAPTOP, -615.0, 31.0, 1797.0, 1054.0),
            (0.0, 25.0, 1512.0, 920.0)
        );
    }

    #[test]
    fn a_window_past_an_edge_is_brought_back_whole() {
        assert_eq!(
            clamp(&LAPTOP, 900.0, 600.0, 1200.0, 800.0),
            (312.0, 145.0, 1200.0, 800.0)
        );
        assert_eq!(
            clamp(&LAPTOP, -300.0, 0.0, 1200.0, 800.0),
            (0.0, 25.0, 1200.0, 800.0)
        );
    }

    #[test]
    fn a_file_in_pixels_from_an_older_build_is_not_trusted() {
        let old: WindowBounds =
            serde_json::from_str(r#"{"width":1797,"height":1054,"x":-615,"y":31}"#).unwrap();
        assert!(!old.logical);
    }
}
