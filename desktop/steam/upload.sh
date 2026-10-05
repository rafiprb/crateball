#!/bin/sh
# Builds the Windows desktop app and uploads it to the Crateball Demo depot on Steam.
# Usage (from the repo root):  sh desktop/steam/upload.sh <steam-username>
# SteamCMD asks for the password and the Steam Guard code itself; nothing is stored here.
# The build lands on the default branch NOT live ("SetLive" is empty): make it live in Steamworks
# (SteamPipe > Builds) once it has been tested.
set -eu
USER_NAME=${1:?usage: sh desktop/steam/upload.sh <steam-username>}
cd "$(dirname "$0")/.."
command -v steamcmd >/dev/null || { echo "steamcmd not found: brew install --cask steamcmd" >&2; exit 1; }
npm run build:win
steamcmd +login "$USER_NAME" +run_app_build "$(pwd)/steam/app_build_demo.vdf" +quit
