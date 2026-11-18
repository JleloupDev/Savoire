// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Reglages types, lus dans la configuration a chaque usage (elle peut changer).

use crate::config::Settings;

/// Fournisseur d'identite (ADR-028) : section « Auth:Oidc ».
#[derive(Clone, Debug)]
pub struct OidcOptions {
    pub authority: Option<String>,
    pub audience: Option<String>,
    pub web_client_id: Option<String>,
    pub desktop_client_id: Option<String>,
    pub require_https_metadata: bool,
    pub scopes: String,
}

impl OidcOptions {
    pub fn from(s: &Settings) -> Self {
        OidcOptions {
            authority: s.str("Auth:Oidc:Authority").map(|a| a.trim_end_matches('/').to_string()),
            audience: s.str("Auth:Oidc:Audience"),
            web_client_id: s.str("Auth:Oidc:WebClientId"),
            desktop_client_id: s.str("Auth:Oidc:DesktopClientId"),
            require_https_metadata: s.bool_or("Auth:Oidc:RequireHttpsMetadata", true),
            scopes: s.str_or("Auth:Oidc:Scopes", "openid profile email offline_access"),
        }
    }
    pub fn enabled(&self) -> bool {
        self.authority.as_deref().is_some_and(|a| !a.trim().is_empty())
            && self.audience.as_deref().is_some_and(|a| !a.trim().is_empty())
    }
}

/// Jetons signes par Savoire (liens de partage, vues integrees) : section « Jwt ».
#[derive(Clone, Debug)]
pub struct JwtOptions {
    pub secret: Option<String>,
    pub issuer: String,
    pub audience: String,
}

impl JwtOptions {
    pub fn from(s: &Settings) -> Self {
        JwtOptions {
            secret: s.str("Jwt:Secret"),
            issuer: s.str_or("Jwt:Issuer", "vault-server"),
            audience: s.str_or("Jwt:Audience", "vault-client"),
        }
    }
}

#[derive(Clone, Debug)]
pub struct IndexerInstance {
    pub name: String,
    pub url: String,
}

#[derive(Clone, Debug, Default)]
pub struct IndexerOidc {
    pub peer_subject: Option<String>,
    pub client_id: Option<String>,
    pub client_secret: Option<String>,
    pub token_endpoint: Option<String>,
    pub scope: Option<String>,
}

impl IndexerOidc {
    pub fn configured(&self) -> bool {
        [&self.peer_subject, &self.client_id, &self.client_secret, &self.token_endpoint]
            .iter()
            .all(|v| v.as_deref().is_some_and(|x| !x.trim().is_empty()))
    }
}

/// Pair indexeur (ADR-027) : section « Indexer ».
#[derive(Clone, Debug)]
pub struct IndexerOptions {
    pub service_token: Option<String>,
    pub oidc: IndexerOidc,
    pub instances: Vec<IndexerInstance>,
    pub timeout_ms: i64,
    pub max_body_bytes: i64,
    pub max_response_bytes: i64,
    pub search_parallelism: i64,
    pub retry_after_seconds: i64,
    pub per_user_per_minute: i64,
    pub per_vault_per_minute: i64,
}

/// Claim pose sur le compte de service du pair.
pub const PEER_CLAIM: &str = "savoire_service";

impl IndexerOptions {
    pub fn from(s: &Settings) -> Self {
        let instances = s
            .section("Indexer")
            .list("Instances")
            .into_iter()
            .map(|v| {
                let i = Settings::from_value(v, "");
                IndexerInstance { name: i.str_or("Name", ""), url: i.str_or("Url", "") }
            })
            .collect();
        IndexerOptions {
            service_token: s.str("Indexer:ServiceToken").filter(|t| !t.trim().is_empty()),
            oidc: IndexerOidc {
                peer_subject: s.str("Indexer:Oidc:PeerSubject"),
                client_id: s.str("Indexer:Oidc:ClientId"),
                client_secret: s.str("Indexer:Oidc:ClientSecret"),
                token_endpoint: s.str("Indexer:Oidc:TokenEndpoint"),
                scope: s.str("Indexer:Oidc:Scope"),
            },
            instances,
            timeout_ms: s.i64_or("Indexer:TimeoutMs", 5000),
            max_body_bytes: s.i64_or("Indexer:MaxBodyBytes", 64 * 1024),
            max_response_bytes: s.i64_or("Indexer:MaxResponseBytes", 8 * 1024 * 1024),
            search_parallelism: s.i64_or("Indexer:SearchParallelism", 4),
            retry_after_seconds: s.i64_or("Indexer:RetryAfterSeconds", 5),
            per_user_per_minute: s.i64_or("Indexer:RateLimit:PerUserPerMinute", 300),
            per_vault_per_minute: s.i64_or("Indexer:RateLimit:PerVaultPerMinute", 1200),
        }
    }

    /// Un jeton de service, ou une identite chez le fournisseur.
    pub fn enabled(&self) -> bool {
        self.service_token.is_some() || self.oidc.configured()
    }

    pub fn find_instance(&self, name: &str) -> Option<&IndexerInstance> {
        self.instances.iter().find(|i| i.name == name)
    }

    /// Erreurs de configuration : le serveur refuse de demarrer, avec la raison.
    pub fn validate(&self) -> Vec<String> {
        let mut errors = vec![];
        let mut names = std::collections::HashSet::new();
        for i in &self.instances {
            if i.name.trim().is_empty() {
                errors.push("Indexer:Instances : nom vide.".to_string());
            } else if !names.insert(i.name.clone()) {
                errors.push(format!("Indexer:Instances : nom en double « {} ».", i.name));
            }
            let ok = url::Url::parse(&i.url).is_ok_and(|u| u.scheme() == "http" || u.scheme() == "https");
            if !ok {
                errors.push(format!("Indexer:Instances : adresse invalide pour « {} » (http(s) absolue attendue).", i.name));
            }
        }
        for (v, name) in [
            (self.timeout_ms, "Indexer:TimeoutMs"),
            (self.max_body_bytes, "Indexer:MaxBodyBytes"),
            (self.max_response_bytes, "Indexer:MaxResponseBytes"),
            (self.search_parallelism, "Indexer:SearchParallelism"),
            (self.retry_after_seconds, "Indexer:RetryAfterSeconds"),
        ] {
            if v <= 0 {
                errors.push(format!("{name} doit etre positif."));
            }
        }
        if self.per_user_per_minute <= 0 || self.per_vault_per_minute <= 0 {
            errors.push("Indexer:RateLimit : les limites doivent etre positives.".to_string());
        }
        errors
    }
}

/// Limites d'usage (section « Limits », revue du 14/11/2026, E4). 0 desactive une limite.
#[derive(Clone, Debug)]
pub struct LimitsOptions {
    pub account_bytes: i64,
    pub vaults_per_account: i64,
    pub min_free_disk_bytes: i64,
    pub disk_check_from_bytes: i64,
    pub hub_calls_per_minute: i64,
    pub uploads_per_minute: i64,
    pub publish_per_minute: i64,
    pub lookups_per_minute: i64,
    pub vault_creations_per_minute: i64,
    pub anonymous_per_minute: i64,
}

impl LimitsOptions {
    pub fn from(s: &Settings) -> Self {
        const GIB: i64 = 1024 * 1024 * 1024;
        LimitsOptions {
            account_bytes: s.i64_or("Limits:AccountBytes", 5 * GIB),
            vaults_per_account: s.i64_or("Limits:VaultsPerAccount", 100),
            min_free_disk_bytes: s.i64_or("Limits:MinFreeDiskBytes", 2 * GIB),
            disk_check_from_bytes: s.i64_or("Limits:DiskCheckFromBytes", 256 * 1024),
            hub_calls_per_minute: s.i64_or("Limits:HubCallsPerMinute", 12_000),
            uploads_per_minute: s.i64_or("Limits:UploadsPerMinute", 120),
            publish_per_minute: s.i64_or("Limits:PublishPerMinute", 30),
            lookups_per_minute: s.i64_or("Limits:LookupsPerMinute", 30),
            vault_creations_per_minute: s.i64_or("Limits:VaultCreationsPerMinute", 20),
            anonymous_per_minute: s.i64_or("Limits:AnonymousPerMinute", 120),
        }
    }
}
