// Crateball desktop: one window onto the live game. The game itself (and its server) stays on the web,
// so the desktop build never goes out of date; a release only changes the website.
import { app, BrowserWindow, shell, Menu } from 'electron';
import path from 'node:path';

const GAME_URL = process.env.CRATEBALL_URL || 'https://playcrateball.com/';
const GAME_ORIGIN = new URL(GAME_URL).origin;

// Steam can start a second copy (double click in the library): focus the first one instead.
if (!app.requestSingleInstanceLock()) app.quit();

let win = null;

function create() {
  win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    backgroundColor: '#1b2347',
    title: 'Crateball',
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  Menu.setApplicationMenu(null);
  win.once('ready-to-show', () => win.show());

  // Only the game runs inside the window; any other link (Steam store, GitHub...) opens in the browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http')) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (new URL(url).origin !== GAME_ORIGIN && !url.startsWith('file:')) {
      e.preventDefault();
      void shell.openExternal(url);
    }
  });

  // No connection: a local page that says so and retries.
  win.webContents.on('did-fail-load', (_e, code, _desc, url, isMainFrame) => {
    if (!isMainFrame || code === -3) return; // -3: aborted (a redirect), not a failure
    void win.loadFile(path.join(import.meta.dirname, 'offline.html'), { query: { url: url || GAME_URL } });
  });

  // F11 or Alt+Enter: fullscreen. F5: reload (also leaves the offline page).
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown') return;
    if (input.key === 'F11' || (input.key === 'Enter' && input.alt)) {
      win.setFullScreen(!win.isFullScreen());
      e.preventDefault();
    } else if (input.key === 'F5') {
      void win.loadURL(GAME_URL);
      e.preventDefault();
    }
  });

  // Smoke test for the build (CRATEBALL_SMOKE=1): report what loaded, then quit.
  if (process.env.CRATEBALL_SMOKE) {
    win.webContents.once('did-finish-load', async () => {
      const title = await win.webContents.executeJavaScript('document.title');
      console.log(`SMOKE loaded ${win.webContents.getURL()} title=${title}`);
      app.quit();
    });
  }

  void win.loadURL(GAME_URL);
}

app.on('second-instance', () => {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.focus();
});
app.whenReady().then(create);
app.on('window-all-closed', () => app.quit());
