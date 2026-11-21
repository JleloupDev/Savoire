// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Mises a jour de l'appli de bureau (tauri-plugin-updater). Trois commandes,
// appelees par le bandeau de la page : chercher, telecharger, redemarrer.
// La page n'a pas acces aux commandes du plugin lui-meme : elle ne choisit ni
// l'adresse, ni le fichier, ni la cle.
//
// - L'annonce vient toujours de la Release GitHub officielle (latest.json,
//   tauri.conf.json), jamais du serveur Savoire auquel on est connecte.
// - Le fichier telecharge n'est installe que s'il est signe par la cle de
//   Savoire. Sa cle publique est fixee au build (SAVOIRE_UPDATER_PUBKEY, mise
//   par la CI des Releases) : sans elle (dev, builds de test), pas de mise a
//   jour du tout.
// - La signature doit porter la version annoncee (requireSignedVersion) :
//   personne ne peut faire reinstaller une ancienne version signee.

use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, State};
use tauri_plugin_updater::{Update, UpdaterExt};

/// La cle publique des mises a jour, ou None si ce build n'en a pas.
pub fn pubkey() -> Option<&'static str> {
    option_env!("SAVOIRE_UPDATER_PUBKEY").map(str::trim).filter(|k| !k.is_empty())
}

/// Le plugin, avec la cle du build (None si le build n'en a pas).
pub fn plugin<R: tauri::Runtime>() -> Option<tauri::plugin::TauriPlugin<R, tauri_plugin_updater::Config>> {
    pubkey().map(|key| tauri_plugin_updater::Builder::new().pubkey(key).build())
}

/// La mise a jour trouvee, puis son fichier une fois telecharge.
#[derive(Default)]
pub struct PendingUpdate(Mutex<Option<(Update, Option<Vec<u8>>)>>);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    version: String,
    current_version: String,
    notes: Option<String>,
}

/// Cherche une version plus recente. None : a jour, ou mises a jour absentes de ce build.
#[tauri::command]
pub async fn update_check(app: AppHandle, pending: State<'_, PendingUpdate>) -> Result<Option<UpdateInfo>, String> {
    if pubkey().is_none() {
        return Ok(None);
    }
    let update = app.updater().map_err(|e| e.to_string())?.check().await.map_err(|e| e.to_string())?;
    let info = update.as_ref().map(|u| UpdateInfo {
        version: u.version.clone(),
        current_version: u.current_version.clone(),
        notes: u.body.clone(),
    });
    *pending.0.lock().map_err(|e| e.to_string())? = update.map(|u| (u, None));
    Ok(info)
}

/// Telecharge la mise a jour trouvee par update_check (sans l'installer).
#[tauri::command]
pub async fn update_download(pending: State<'_, PendingUpdate>) -> Result<(), String> {
    let update = {
        let guard = pending.0.lock().map_err(|e| e.to_string())?;
        match guard.as_ref() {
            Some((_, Some(_))) => return Ok(()),
            Some((update, None)) => update.clone(),
            None => return Err("aucune mise a jour en attente".into()),
        }
    };
    let bytes = update.download(|_, _| {}, || {}).await.map_err(|e| e.to_string())?;
    let mut guard = pending.0.lock().map_err(|e| e.to_string())?;
    if let Some((current, slot)) = guard.as_mut() {
        if current.version == update.version {
            *slot = Some(bytes);
        }
    }
    Ok(())
}

/// Installe le fichier telecharge (signature verifiee) et redemarre l'appli.
/// Windows : l'installeur ferme l'appli lui-meme et la relance.
#[tauri::command]
pub async fn update_restart(app: AppHandle, pending: State<'_, PendingUpdate>) -> Result<(), String> {
    let (update, bytes) = pending
        .0
        .lock()
        .map_err(|e| e.to_string())?
        .take()
        .ok_or("aucune mise a jour en attente")?;
    let bytes = bytes.ok_or("mise a jour pas encore telechargee")?;
    update.install(bytes).map_err(|e| e.to_string())?;
    app.restart();
}
