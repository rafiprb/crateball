#!/bin/sh
# Downloads the latest successful Desktop workflow build from main (GitHub Actions) into desktop/out:
# out/windows/Crateball.exe and out/macos/Crateball.app. Nothing is compiled locally (Rust stays off
# this machine). Pass a run id to pick a specific build.
# Usage (from the repo root):  sh desktop/steam/fetch-builds.sh [run-id]
set -eu
cd "$(dirname "$0")/.."
REPO=rafiprb/crateball
RUN=${1:-$(gh run list --repo "$REPO" --workflow desktop.yml --branch main --status success --limit 1 --json databaseId --jq '.[0].databaseId')}
[ -n "$RUN" ] || { echo "no successful Desktop build on main: run it in GitHub Actions first" >&2; exit 1; }
echo "Desktop build: https://github.com/$REPO/actions/runs/$RUN"
rm -rf out/windows out/macos out/download
mkdir -p out/windows out/macos
gh run download "$RUN" --repo "$REPO" --dir out/download
mv out/download/Crateball-windows/Crateball.exe out/windows/
ditto -x -k out/download/Crateball-macos/Crateball-macos.zip out/macos/
rm -rf out/download
du -sh out/windows out/macos
