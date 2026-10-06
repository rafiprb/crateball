#!/bin/sh
# Builds Windows + macOS and uploads both to the main Crateball app (4248630): depot 4248631 = Windows,
# 4248632 = macOS. Key holders get it before release. Uploaded NOT live: set the build live on the
# default branch in Steamworks (SteamPipe > Builds).
# Usage (from the repo root):  sh desktop/steam/upload-main.sh <steam-username>
set -eu
USER_NAME=${1:?usage: sh desktop/steam/upload-main.sh <steam-username>}
cd "$(dirname "$0")/.."
command -v steamcmd >/dev/null || { echo "steamcmd not found: brew install --cask steamcmd" >&2; exit 1; }
npm run build:win
npm run build:mac
steamcmd +login "$USER_NAME" +run_app_build "$(pwd)/steam/app_build_main.vdf" +quit
