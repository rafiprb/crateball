# Crateball desktop (Steam)

An Electron window onto https://playcrateball.com. The game and its server stay on the web, so a
website release updates the desktop build too; this only needs rebuilding when the wrapper changes.

- `npm install` (here, not in the pnpm workspace: Electron is large and CI does not need it)
- `npm start`: run it locally. `CRATEBALL_URL=http://localhost:5173 npm start` points it at a dev server.
- `npm run build:win` (also `build:mac`, `build:linux`): packaged app in `out/`.
- `sh desktop/steam/upload.sh <steam-username>` (from the repo root): build and upload to the
  Crateball Demo depot (app 4248750, depot 4248751). Needs `steamcmd`.

Steam launch option for Windows: executable `Crateball.exe`, no arguments.
F11 or Alt+Enter toggles fullscreen, F5 reloads. Without a connection it shows a retry page.
