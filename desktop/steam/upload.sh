#!/bin/sh
# Fetches the Windows and macOS builds from GitHub Actions (fetch-builds.sh) and uploads them to the
# Crateball Demo on Steam (depot 4248751 = Windows, 4248752 = macOS).
# Usage (from the repo root):  sh desktop/steam/upload.sh <steam-username> [branch] [run-id]
# SteamCMD asks for the password and the Steam Guard code itself (or reuses its cached login); nothing
# is stored here. Without a branch the build is uploaded NOT live: set it live in Steamworks
# (SteamPipe > Builds) once tested. With a branch (e.g. beta) it goes live on that branch right away;
# the branch must already exist in Steamworks. The default branch is never set from here.
set -eu
USER_NAME=${1:?usage: sh desktop/steam/upload.sh <steam-username> [branch]}
BRANCH=${2:-}
RUN=${3:-}
[ "$BRANCH" = "default" ] && { echo "set the default branch live in Steamworks, not from here" >&2; exit 2; }
cd "$(dirname "$0")/.."
command -v steamcmd >/dev/null || { echo "steamcmd not found: brew install --cask steamcmd" >&2; exit 1; }
sh steam/fetch-builds.sh $RUN
VDF="$(pwd)/out/app_build_demo.vdf"
sed "s/\"SetLive\" \"\"/\"SetLive\" \"$BRANCH\"/" steam/app_build_demo.vdf > "$VDF"
# ContentRoot/BuildOutput in the template are relative to steam/; the generated copy lives in out/.
sed -i '' 's#"\.\./out/"#"./"#; s#"\.\./out/steam-build/"#"./steam-build/"#' "$VDF"
steamcmd +login "$USER_NAME" +run_app_build "$VDF" +quit
