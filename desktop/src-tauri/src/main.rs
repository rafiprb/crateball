// Crateball desktop: one window onto the live game. The game itself (and its server) stays on the web,
// so the desktop build never goes out of date; a release only changes the website.
// The window opens on a local start page (web/index.html: logo, connection check, offline retry) that
// moves on to the game as soon as the server answers.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::webview::{NewWindowResponse, PageLoadEvent};
use tauri::window::Color;
use tauri::{Manager, Url, WebviewUrl, WebviewWindowBuilder};

const DEFAULT_GAME_URL: &str = "https://playcrateball.com/";

// Where the bundled start page lives (F5 goes back there, so a reload also re-checks the connection).
#[cfg(windows)]
const HOME_URL: &str = "http://tauri.localhost/index.html";
#[cfg(not(windows))]
const HOME_URL: &str = "tauri://localhost/index.html";

fn is_local(url: &Url) -> bool {
    matches!(url.scheme(), "tauri" | "about" | "data" | "blob") || url.host_str() == Some("tauri.localhost")
}

fn main() {
    let game_url = std::env::var("CRATEBALL_URL").unwrap_or_else(|_| DEFAULT_GAME_URL.to_string());
    let game_origin = Url::parse(&game_url).expect("CRATEBALL_URL is not a URL").origin();
    // CRATEBALL_SMOKE=<file>: write what loaded into the file and quit (build check in CI).
    let smoke = std::env::var("CRATEBALL_SMOKE").ok();

    // Runs in every page: tells the start page where the game is, and gives the game F11 / Alt+Enter
    // (fullscreen) and F5 (reload through the start page).
    let init = format!(
        r#"window.__CRATEBALL_URL__ = {game:?};
addEventListener('keydown', (e) => {{
  const invoke = window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke;
  if (e.key === 'F11' || (e.key === 'Enter' && e.altKey)) {{
    e.preventDefault();
    if (invoke) invoke('plugin:window|is_fullscreen').then((on) => invoke('plugin:window|set_fullscreen', {{ value: !on }}));
  }} else if (e.key === 'F5') {{
    e.preventDefault();
    location.replace({home:?});
  }}
}}, true);"#,
        game = game_url,
        home = HOME_URL,
    );

    tauri::Builder::default()
        // Steam can start a second copy (double click in the library): focus the first one instead.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.unminimize();
                let _ = win.set_focus();
            }
        }))
        .plugin(tauri_plugin_opener::init())
        .setup(move |app| {
            let nav_origin = game_origin.clone();
            let page_origin = game_origin.clone();
            WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("Crateball")
                .inner_size(1280.0, 800.0)
                .min_inner_size(960.0, 600.0)
                .background_color(Color(13, 19, 48, 255))
                .initialization_script(&init)
                // Only the game runs inside the window; any other link (Steam store, GitHub...) opens in
                // the browser.
                .on_navigation(move |url| {
                    if is_local(url) || url.origin() == nav_origin {
                        return true;
                    }
                    let _ = tauri_plugin_opener::open_url(url.as_str(), None::<&str>);
                    false
                })
                .on_new_window(|url, _features| {
                    if url.scheme().starts_with("http") {
                        let _ = tauri_plugin_opener::open_url(url.as_str(), None::<&str>);
                    }
                    NewWindowResponse::Deny
                })
                .on_page_load(move |win, payload| {
                    let Some(file) = &smoke else { return };
                    if payload.event() == PageLoadEvent::Finished && payload.url().origin() == page_origin {
                        let _ = std::fs::write(file, format!("SMOKE loaded {}\n", payload.url()));
                        win.app_handle().exit(0);
                    }
                })
                .build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("Crateball failed to start");
}
