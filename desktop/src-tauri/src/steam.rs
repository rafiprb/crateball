// Steam stats and achievements for the game page (packages/client/src/steam.ts): it adds a finished
// match's numbers to the player's stats, then unlocks what the totals have reached. Which achievement
// needs what lives only in the game (packages/client/src/achievements.ts); this side only checks names.
// Started outside Steam (or as the demo, which has no achievements) there is no client and every
// command answers an error, which the page ignores.

use std::collections::HashMap;
use std::time::Duration;
use steamworks::Client;
use tauri::State;

/// The main app; the demo (4248750) runs the same build and records nothing.
const MAIN_APP: u32 = 4248630;
/// A single match never adds more than this to one stat (Steam's own "max change" is the real cap).
const MAX_ADD: i32 = 100;

pub struct Steam(Option<Client>);

impl Steam {
    pub fn init() -> Steam {
        let client = match Client::init() {
            Ok(c) if c.utils().app_id().0 == MAIN_APP => c,
            _ => return Steam(None),
        };
        // Steam's callbacks (the stats arriving, a store finishing) are dispatched by hand.
        let pump = client.clone();
        std::thread::spawn(move || loop {
            pump.run_callbacks();
            std::thread::sleep(Duration::from_millis(100));
        });
        Steam(Some(client))
    }
}

/// An API name as Steamworks allows it: letters, digits and underscores.
fn api_name(name: &str) -> bool {
    !name.is_empty() && name.len() <= 64 && name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
}

fn client<'a>(steam: &'a State<Steam>) -> Result<&'a Client, String> {
    steam.0.as_ref().ok_or_else(|| "no steam".to_string())
}

/// Adds to the named stats and stores them; answers the new totals. All or nothing: on any error the
/// stats are as before, so the page may send the same match again.
#[tauri::command]
pub fn steam_add_stats(steam: State<Steam>, add: HashMap<String, i32>) -> Result<HashMap<String, i32>, String> {
    let stats = client(&steam)?.user_stats();
    // Every stat read before any is changed.
    let mut old = HashMap::new();
    for name in add.keys() {
        if !api_name(name) {
            return Err(format!("bad stat {name}"));
        }
        old.insert(name.clone(), stats.get_stat_i32(name).map_err(|_| format!("no stat {name}"))?);
    }
    let totals: HashMap<String, i32> =
        add.iter().map(|(name, n)| (name.clone(), old[name].saturating_add((*n).clamp(0, MAX_ADD)))).collect();
    let stored = totals.iter().all(|(name, n)| stats.set_stat_i32(name, *n).is_ok()) && stats.store_stats().is_ok();
    if !stored {
        for (name, n) in &old {
            let _ = stats.set_stat_i32(name, *n);
        }
        return Err("stats not stored".to_string());
    }
    Ok(totals)
}

/// Unlocks the named achievements and stores them; answers the ones that were not unlocked before.
#[tauri::command]
pub fn steam_unlock(steam: State<Steam>, names: Vec<String>) -> Result<Vec<String>, String> {
    let stats = client(&steam)?.user_stats();
    let mut new = Vec::new();
    for name in names.into_iter().filter(|n| api_name(n)).take(64) {
        let a = stats.achievement(&name);
        if a.get() == Ok(false) && a.set().is_ok() {
            new.push(name);
        }
    }
    if !new.is_empty() {
        stats.store_stats().map_err(|_| "stats not stored".to_string())?;
    }
    Ok(new)
}
