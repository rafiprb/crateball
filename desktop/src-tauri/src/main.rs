// Crateball desktop: one window onto the live game. The game itself (and its server) stays on the web,
// so the desktop build never goes out of date; a release only changes the website.
// The window opens on a local start page (web/index.html: logo, connection check, offline retry) that
// moves on to the game as soon as the server answers.
// Goal replays (.crateball files) open here when double-clicked: the file is read and handed to the game
// page (base64 in `window.__CRATEBALL_FILES__` and a `crateball-file` event), which plays it.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::webview::{DownloadEvent, NewWindowResponse, PageLoadEvent};
use tauri::window::Color;
use tauri::{AppHandle, Manager, Url, WebviewUrl, WebviewWindowBuilder};

const DEFAULT_GAME_URL: &str = "https://playcrateball.com/";
/// A replay file is a few KB; anything far bigger is not one (the game checks it again).
const MAX_REPLAY_BYTES: u64 = 2 * 1024 * 1024;

/// Replay files waiting for the game page (it may still be loading, or offline on the start page).
#[derive(Default)]
struct Replays(Mutex<Vec<String>>);

/// Where the game runs (CRATEBALL_URL or playcrateball.com).
struct Game(Url);

// Where the bundled start page lives (F5 goes back there, so a reload also re-checks the connection).
#[cfg(windows)]
const HOME_URL: &str = "http://tauri.localhost/index.html";
#[cfg(not(windows))]
const HOME_URL: &str = "tauri://localhost/index.html";

/// The bundled start page itself (and the empty page a webview may pass through), nothing broader:
/// no data:, blob: or other about: pages.
fn is_local(url: &Url) -> bool {
    let host = url.host_str();
    (url.scheme() == "tauri" && host == Some("localhost"))
        || (url.scheme() == "http" && host == Some("tauri.localhost"))
        || url.as_str() == "about:blank"
}

/// Only plain web links leave the window, opened in the user's browser. Anything else (file:, another
/// app's custom scheme, javascript:) is dropped: the opener would hand it to the OS as is.
fn open_external(url: &Url) {
    if matches!(url.scheme(), "http" | "https") && url.host_str().is_some() {
        let _ = tauri_plugin_opener::open_url(url.as_str(), None::<&str>);
    }
}

fn base64(bytes: &[u8]) -> String {
    const ABC: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for c in bytes.chunks(3) {
        let n = (c[0] as u32) << 16 | (*c.get(1).unwrap_or(&0) as u32) << 8 | *c.get(2).unwrap_or(&0) as u32;
        for i in 0..4 {
            if i <= c.len() {
                out.push(ABC[(n >> (18 - 6 * i) & 63) as usize] as char);
            } else {
                out.push('=');
            }
        }
    }
    out
}

/// A double-clicked (or command-line) file: if it is a replay, queue it for the game page. Read on its own
/// thread: whatever the path turns out to be (a pipe swapped in at the last moment), the window never waits.
fn open_replay(app: &AppHandle, path: &Path) {
    let is_replay = path
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("crateball"));
    if !is_replay {
        return;
    }
    let (app, path) = (app.clone(), path.to_path_buf());
    std::thread::spawn(move || {
        // A regular file only (checked on the opened file, not /dev/zero or a pipe), and never more than the
        // limit read, even if it grows meanwhile.
        let Ok(file) = std::fs::File::open(&path) else { return };
        if !file.metadata().is_ok_and(|m| m.is_file()) {
            return;
        }
        let mut bytes = Vec::new();
        if file.take(MAX_REPLAY_BYTES + 1).read_to_end(&mut bytes).is_err() || bytes.len() as u64 > MAX_REPLAY_BYTES {
            return;
        }
        app.state::<Replays>().0.lock().unwrap().push(base64(&bytes));
        // Webview calls belong on the main thread.
        let handle = app.clone();
        let _ = app.run_on_main_thread(move || deliver(&handle));
    });
}

/// Files among a launch's arguments (the first is the program itself), relative to its directory.
fn open_args(app: &AppHandle, args: &[String], cwd: &Path) {
    for a in args.iter().skip(1) {
        let p = PathBuf::from(a);
        open_replay(app, &if p.is_absolute() { p } else { cwd.join(p) });
    }
}

/// Hands the waiting replays to the game page, once the window shows the game (else they wait for its
/// page load).
fn deliver(app: &AppHandle) {
    let Some(win) = app.get_webview_window("main") else { return };
    let game = app.state::<Game>().0.origin();
    if !win.url().is_ok_and(|u| u.origin() == game) {
        return;
    }
    let files = std::mem::take(&mut *app.state::<Replays>().0.lock().unwrap());
    if files.is_empty() {
        return;
    }
    let list = files.iter().map(|f| format!("{f:?}")).collect::<Vec<_>>().join(",");
    let _ = win.eval(format!(
        "(window.__CRATEBALL_FILES__ = window.__CRATEBALL_FILES__ || []).push({list}); \
         window.dispatchEvent(new Event('crateball-file'));"
    ));
    let _ = win.unminimize();
    let _ = win.set_focus();
}

/// Windows: double-clicking a .crateball file starts this exe (per user, no installer needed: Steam only
/// copies files). Written on every start, so a moved install stays right.
#[cfg(windows)]
fn register_file_type() {
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;
    let Ok(exe) = std::env::current_exe() else { return };
    let exe = exe.display().to_string();
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let set = |key: &str, value: String| {
        if let Ok((k, _)) = hkcu.create_subkey(format!("Software\\Classes\\{key}")) {
            let _ = k.set_value("", &value);
        }
    };
    set(".crateball", "Crateball.Replay".into());
    set("Crateball.Replay", "Crateball replay".into());
    set("Crateball.Replay\\DefaultIcon", format!("\"{exe}\",0"));
    set("Crateball.Replay\\shell\\open\\command", format!("\"{exe}\" \"%1\""));
}

/// A saved download (a replay file from the game) goes to Downloads, never over an existing file.
fn download_path(app: &AppHandle, suggested: &Path) -> Option<PathBuf> {
    let dir = app.path().download_dir().ok()?;
    let name = suggested.file_name()?.to_string_lossy().into_owned();
    let (stem, ext) = match name.rsplit_once('.') {
        Some((s, e)) => (s.to_string(), format!(".{e}")),
        None => (name.clone(), String::new()),
    };
    let mut path = dir.join(&name);
    let mut n = 1;
    while path.exists() {
        path = dir.join(format!("{stem} ({n}){ext}"));
        n += 1;
    }
    Some(path)
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

    let app = tauri::Builder::default()
        // Steam can start a second copy (double click in the library), and so does a double-clicked replay
        // on Windows: focus the first one instead, and hand it the file.
        .plugin(tauri_plugin_single_instance::init(|app, args, cwd| {
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.unminimize();
                let _ = win.set_focus();
            }
            open_args(app, &args, Path::new(&cwd));
        }))
        .plugin(tauri_plugin_opener::init())
        .manage(Replays::default())
        .manage(Game(Url::parse(&game_url).expect("CRATEBALL_URL is not a URL")))
        .setup(move |app| {
            #[cfg(windows)]
            register_file_type();
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
                    open_external(url);
                    false
                })
                .on_new_window(|url, _features| {
                    open_external(&url);
                    NewWindowResponse::Deny
                })
                // Files dropped on the window reach the page (the game opens dropped replays itself).
                .disable_drag_drop_handler()
                .on_download(|webview, event| {
                    if let DownloadEvent::Requested { destination, .. } = event {
                        if let Some(path) = download_path(webview.app_handle(), &*destination) {
                            *destination = path;
                        }
                    }
                    true
                })
                .on_page_load(move |win, payload| {
                    if payload.event() != PageLoadEvent::Finished || payload.url().origin() != page_origin {
                        return;
                    }
                    deliver(win.app_handle());
                    if let Some(file) = &smoke {
                        let _ = std::fs::write(file, format!("SMOKE loaded {}\n", payload.url()));
                        win.app_handle().exit(0);
                    }
                })
                .build()?;
            // Started by a double-clicked replay (Windows): the file is in the arguments.
            let args: Vec<String> = std::env::args_os().map(|a| a.to_string_lossy().into_owned()).collect();
            let cwd = std::env::current_dir().unwrap_or_default();
            open_args(app.handle(), &args, &cwd);
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("Crateball failed to start");
    app.run(|app, event| {
        // macOS: a double-clicked replay (whether or not the game was running).
        #[cfg(target_os = "macos")]
        if let tauri::RunEvent::Opened { urls } = &event {
            for url in urls {
                if let Ok(path) = url.to_file_path() {
                    open_replay(app, &path);
                }
            }
        }
        let _ = (app, event);
    });
}
