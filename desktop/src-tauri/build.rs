fn main() {
    // The app's own commands get permissions (allow-steam-add-stats...), granted to the game page in
    // capabilities/game.json; nothing else may call them.
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(&["steam_add_stats", "steam_unlock"])),
    )
    .expect("tauri build script failed");
}
