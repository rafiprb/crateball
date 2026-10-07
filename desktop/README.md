# Crateball desktop (Steam)

A [Tauri](https://tauri.app) window onto https://playcrateball.com. It uses the system webview
(WebView2 on Windows 10/11, WKWebView on macOS), so the app is a few MB instead of a bundled Chromium.
The game and its server stay on the web, so a website release updates the desktop build too; this only
needs rebuilding when the wrapper changes.

- `src-tauri/`: the Rust wrapper (`src/main.rs`) and its config. `web/index.html` is the bundled start
  page: the same splash as the website, a connection check, and a retry screen when offline.
- **Built only in GitHub Actions** (`.github/workflows/desktop.yml`, runs on pushes that touch
  `desktop/` or by hand): Rust and its multi-GB build cache never go on a laptop. Each build is smoke
  tested (the window must load the game) and leaves two artifacts: `Crateball-windows` (Crateball.exe)
  and `Crateball-macos` (universal Crateball.app, ad-hoc signed, zipped).
- `sh desktop/steam/fetch-builds.sh [run-id]`: download the latest (or a given) build into `out/`.
- `sh desktop/steam/upload.sh <steam-username> [branch] [run-id]` (from the repo root): fetch and upload
  to the Crateball Demo (app 4248750, depots 4248751 Windows / 4248752 macOS). Needs `steamcmd` and `gh`.
- `sh desktop/steam/upload-main.sh <steam-username> [run-id]`: same for the main app (4248630, depots
  4248631 / 4248632).

Steam launch options: `Crateball.exe` (Windows), `Crateball.app` (macOS).
F11 or Alt+Enter toggles fullscreen, F5 reloads. `CRATEBALL_URL` points the app at another server
(e.g. a dev server); `CRATEBALL_SMOKE=<file>` writes what loaded into the file and quits.
