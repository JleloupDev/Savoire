// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Quota de stockage (revue du 14/11/2026, E4 ; reglages : section Limits).
//
// Ce qu'occupe un vault : ses fichiers, son journal CRDT (repertoire, index,
// notes, dessins), ses pages publiees et ses blobs EdgeSync. Le total est
// mesure a la demande puis garde en memoire ; chaque ajout l'augmente, et il
// est remesure toutes les dix minutes ou quand le contenu diminue.
//
// Le quota est celui du PROPRIETAIRE du vault : la somme de ses vaults. Une
// seule instance de l'API (ADR-028) : le compteur est dans ce processus.

use std::sync::Arc;
use std::sync::atomic::{AtomicI64, Ordering};
use std::time::{Duration, Instant};

use dashmap::DashMap;
use serde::Serialize;

use crate::db::{PgPool, repos};
use crate::error::{AppError, AppResult};
use crate::options::LimitsOptions;
use crate::services::storage::ContentStore;

const USAGE_TTL: Duration = Duration::from_secs(600);
const OWNER_TTL: Duration = Duration::from_secs(60);

struct Counter {
    bytes: AtomicI64,
    at: Instant,
}

#[derive(Clone)]
struct Owned {
    vaults: Vec<(String, String)>,
    at: Instant,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct VaultUsage {
    pub vault_id: String,
    pub name: String,
    pub bytes: i64,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AccountUsage {
    pub used_bytes: i64,
    pub quota_bytes: i64,
    pub vaults: Vec<VaultUsage>,
}

pub struct Quota {
    db: PgPool,
    files: ContentStore,
    usage: DashMap<String, Arc<Counter>>,
    owners: DashMap<String, Owned>,
}

impl Quota {
    pub fn new(db: PgPool, files: ContentStore) -> Self {
        Quota { db, files, usage: DashMap::new(), owners: DashMap::new() }
    }

    /// Refuse si le proprietaire du vault n'a plus la place pour `bytes`, ou
    /// les gros envois si le disque du serveur est presque plein.
    pub async fn ensure_room(&self, limits: &LimitsOptions, vault_id: &str, bytes: i64) -> AppResult<()> {
        if limits.min_free_disk_bytes > 0
            && bytes >= limits.disk_check_from_bytes
            && let Some(free) = self.files.free_bytes()
            && free - bytes < limits.min_free_disk_bytes
        {
            return Err(AppError::StorageUnavailable);
        }
        if limits.account_bytes <= 0 {
            return Ok(());
        }
        // Vault inconnu : le controle d'acces l'a deja refuse.
        let Some(owned) = self.owned_by_owner_of(vault_id).await? else { return Ok(()) };
        let mut used = 0;
        for (id, _) in &owned.vaults {
            used += self.bytes_of(id).await?;
        }
        if used + bytes > limits.account_bytes {
            return Err(AppError::QuotaExceeded(format!(
                "Le propriétaire de ce vault a atteint son quota de stockage ({}). \
                 Il faut libérer de la place (fichiers, vaults) pour y ajouter du contenu.",
                gb(limits.account_bytes)
            )));
        }
        Ok(())
    }

    /// Des octets viennent d'etre ajoutes au vault.
    pub fn added(&self, vault_id: &str, bytes: i64) {
        if bytes > 0
            && let Some(c) = self.usage.get(vault_id)
        {
            c.bytes.fetch_add(bytes, Ordering::Relaxed);
        }
    }

    /// Le contenu du vault a diminue : son compteur sera recalcule.
    pub fn invalidate(&self, vault_id: &str) {
        self.usage.remove(vault_id);
        self.owners.remove(vault_id);
    }

    pub async fn usage_of_account(&self, limits: &LimitsOptions, user_id: &str) -> AppResult<AccountUsage> {
        let mut c = self.db.acquire().await?;
        let vaults = repos::vaults_owned_by(&mut c, user_id).await?;
        drop(c);
        let mut list = vec![];
        for (id, name) in vaults {
            let bytes = self.bytes_of(&id).await?;
            list.push(VaultUsage { vault_id: id, name, bytes });
        }
        Ok(AccountUsage { used_bytes: list.iter().map(|v| v.bytes).sum(), quota_bytes: limits.account_bytes.max(0), vaults: list })
    }

    pub async fn owned_vault_count(&self, user_id: &str) -> AppResult<usize> {
        let mut c = self.db.acquire().await?;
        Ok(repos::vaults_owned_by(&mut c, user_id).await?.len())
    }

    async fn owned_by_owner_of(&self, vault_id: &str) -> AppResult<Option<Owned>> {
        if let Some(known) = self.owners.get(vault_id)
            && known.at.elapsed() < OWNER_TTL
        {
            return Ok(Some(known.clone()));
        }
        let mut c = self.db.acquire().await?;
        let Some(vault) = repos::vault_get(&mut c, vault_id).await? else { return Ok(None) };
        let owned = Owned { vaults: repos::vaults_owned_by(&mut c, &vault.owner_id).await?, at: Instant::now() };
        self.owners.insert(vault_id.to_string(), owned.clone());
        Ok(Some(owned))
    }

    async fn bytes_of(&self, vault_id: &str) -> AppResult<i64> {
        if let Some(c) = self.usage.get(vault_id)
            && c.at.elapsed() < USAGE_TTL
        {
            return Ok(c.bytes.load(Ordering::Relaxed));
        }
        let mut c = self.db.acquire().await?;
        let bytes = self.files.vault_bytes(vault_id).await? + repos::vault_row_bytes(&mut c, vault_id).await?;
        self.usage.insert(vault_id.to_string(), Arc::new(Counter { bytes: AtomicI64::new(bytes), at: Instant::now() }));
        Ok(bytes)
    }
}

fn gb(bytes: i64) -> String {
    let v = bytes as f64 / (1024.0 * 1024.0 * 1024.0);
    let s = format!("{:.1}", v);
    let s = s.strip_suffix(".0").unwrap_or(&s).to_string();
    format!("{s} Go")
}

#[cfg(test)]
mod tests {
    #[test]
    fn gb_format() {
        assert_eq!(super::gb(5 * 1024 * 1024 * 1024), "5 Go");
        assert_eq!(super::gb(1024 * 1024 * 1024 + 512 * 1024 * 1024), "1.5 Go");
    }
}
