// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Surveillance du disque d'un vault (port IVaultFileSystem.watch).
//
// Une surveillance par appel a vault_watch. Les changements partent vers la
// page en evenement « vault-fs-change », avec l'identifiant de la
// surveillance et des chemins RELATIFS. Les fichiers temporaires des
// ecritures atomiques (.savoire/tmp) ne sont jamais signales.

use crate::paths;
use crate::vaults::VaultRegistry;
use notify::event::{ModifyKind, RenameMode};
use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, State};

pub const EVENT: &str = "vault-fs-change";

#[derive(Clone, Serialize, Debug, PartialEq)]
pub struct Change {
    pub path: String,
    pub kind: &'static str,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Payload {
    watch_id: u32,
    changes: Vec<Change>,
}

#[derive(Default)]
pub struct Watches {
    next: AtomicU32,
    active: Mutex<HashMap<u32, RecommendedWatcher>>,
}

/// Traduit un evenement de `notify` en changements du port (logique pure).
pub fn translate(root: &Path, event: &Event) -> Vec<Change> {
    let rel = |p: &PathBuf| paths::to_relative(root, p).filter(|r| !paths::is_internal_tmp(r));
    let mut out = Vec::new();
    let mut push = |p: &PathBuf, kind: &'static str| {
        if let Some(path) = rel(p) {
            out.push(Change { path, kind });
        }
    };
    match &event.kind {
        EventKind::Create(_) => event.paths.iter().for_each(|p| push(p, "created")),
        EventKind::Remove(_) => event.paths.iter().for_each(|p| push(p, "deleted")),
        EventKind::Modify(ModifyKind::Name(mode)) => match mode {
            RenameMode::From => event.paths.iter().for_each(|p| push(p, "deleted")),
            RenameMode::To => event.paths.iter().for_each(|p| push(p, "created")),
            RenameMode::Both if event.paths.len() == 2 => {
                push(&event.paths[0], "deleted");
                push(&event.paths[1], "created");
            }
            _ => event
                .paths
                .iter()
                .for_each(|p| push(p, if p.exists() { "created" } else { "deleted" })),
        },
        // Les seuls changements de droits ou de dates ne changent pas le contenu.
        EventKind::Modify(ModifyKind::Metadata(_)) => {}
        EventKind::Modify(_) => event.paths.iter().for_each(|p| push(p, "modified")),
        _ => {}
    }
    out
}

#[tauri::command]
pub fn vault_watch(
    app: AppHandle,
    reg: State<'_, VaultRegistry>,
    watches: State<'_, Watches>,
    root: String,
) -> Result<u32, String> {
    let root_path = reg.root(&root)?;
    let id = watches.next.fetch_add(1, Ordering::Relaxed) + 1;
    let base = root_path.clone();
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<Event>| {
        if let Ok(event) = res {
            let changes = translate(&base, &event);
            if !changes.is_empty() {
                let _ = app.emit(EVENT, Payload { watch_id: id, changes });
            }
        }
    })
    .map_err(|e| e.to_string())?;
    watcher
        .watch(&root_path, RecursiveMode::Recursive)
        .map_err(|e| e.to_string())?;
    watches.active.lock().unwrap().insert(id, watcher);
    Ok(id)
}

#[tauri::command]
pub fn vault_unwatch(watches: State<'_, Watches>, watch_id: u32) {
    // Lacher le Watcher arrete la surveillance.
    watches.active.lock().unwrap().remove(&watch_id);
}

#[cfg(test)]
mod tests {
    use super::*;
    use notify::event::{CreateKind, DataChange, MetadataKind, RemoveKind};

    fn ev(kind: EventKind, paths: &[&str]) -> Event {
        let mut e = Event::new(kind);
        for p in paths {
            e = e.add_path(PathBuf::from(p));
        }
        e
    }

    #[test]
    fn traduit_les_evenements() {
        let root = Path::new("/v");
        assert_eq!(
            translate(root, &ev(EventKind::Create(CreateKind::File), &["/v/a.md"])),
            vec![Change { path: "a.md".into(), kind: "created" }]
        );
        assert_eq!(
            translate(root, &ev(EventKind::Modify(ModifyKind::Data(DataChange::Content)), &["/v/d/b.md"])),
            vec![Change { path: "d/b.md".into(), kind: "modified" }]
        );
        assert_eq!(
            translate(root, &ev(EventKind::Remove(RemoveKind::File), &["/v/a.md"])),
            vec![Change { path: "a.md".into(), kind: "deleted" }]
        );
        assert_eq!(
            translate(
                root,
                &ev(EventKind::Modify(ModifyKind::Name(RenameMode::Both)), &["/v/a.md", "/v/b.md"])
            ),
            vec![
                Change { path: "a.md".into(), kind: "deleted" },
                Change { path: "b.md".into(), kind: "created" }
            ]
        );
        assert!(translate(root, &ev(EventKind::Modify(ModifyKind::Metadata(MetadataKind::Any)), &["/v/a.md"])).is_empty());
        // Ecriture atomique : le fichier temporaire est tu, le renommage final parle.
        assert!(translate(root, &ev(EventKind::Create(CreateKind::File), &["/v/.savoire/tmp/1-0.tmp"])).is_empty());
        assert_eq!(
            translate(
                root,
                &ev(EventKind::Modify(ModifyKind::Name(RenameMode::Both)), &["/v/.savoire/tmp/1-0.tmp", "/v/a.md"])
            ),
            vec![Change { path: "a.md".into(), kind: "created" }]
        );
        // Hors de la racine (ou la racine elle-meme) : rien.
        assert!(translate(root, &ev(EventKind::Create(CreateKind::File), &["/w/a.md"])).is_empty());
    }
}
