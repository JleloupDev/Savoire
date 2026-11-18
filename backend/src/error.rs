// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Erreurs de l'application et leur traduction en Problem Details (RFC 7807),
// comme le faisait DomainExceptionHandler du serveur .NET : memes statuts,
// memes types (https://errors.app/{type}), meme titre.

use axum::http::{HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use serde_json::json;

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("{0}")]
    Unauthorized(String),
    #[error("{0}")]
    Validation(String),
    #[error("Le vault '{0}' n'existe pas ou vous n'y avez pas accès.")]
    VaultNotFound(String),
    /// Le document n'est pas inscrit dans le vault annonce : meme reponse que
    /// VaultNotFound cote REST (masque) ; les hubs, eux, la distinguent.
    #[error("Le vault '{0}' n'existe pas ou vous n'y avez pas accès.")]
    DocumentNotInVault(String),
    #[error("Le document '{0}' n'existe pas.")]
    DocumentNotFound(String),
    #[error("Le dossier '{0}' n'existe pas.")]
    FolderNotFound(String),
    #[error("Utilisateur '{0}' introuvable.")]
    UserNotFound(String),
    #[error("{0}")]
    AccessDenied(String),
    #[error("Le chemin '{0}' est déjà utilisé.")]
    PathConflict(String),
    #[error("Le dossier '{0}' contient des documents. Utilisez ?force=true pour forcer la suppression.")]
    FolderNotEmpty(String),
    #[error("{0}")]
    QuotaExceeded(String),
    #[error("Le serveur n'a plus assez de place pour cet envoi. Réessayez plus tard.")]
    StorageUnavailable,
    #[error("Trop de requêtes en peu de temps. Réessayez dans un instant.")]
    TooManyRequests,
    #[error("{0}")]
    IdentityProvider(String),
    /// Argument invalide (ArgumentException cote .NET : 500).
    #[error("{0}")]
    BadArgument(String),
    #[error(transparent)]
    Db(#[from] sqlx::Error),
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error("{0}")]
    Internal(String),
}

pub type AppResult<T> = Result<T, AppError>;

impl AppError {
    pub fn validation(msg: impl Into<String>) -> Self {
        AppError::Validation(msg.into())
    }
    pub fn denied(msg: impl Into<String>) -> Self {
        AppError::AccessDenied(msg.into())
    }
    pub fn internal(msg: impl std::fmt::Display) -> Self {
        AppError::Internal(msg.to_string())
    }

    pub fn is_vault_not_found(&self) -> bool {
        matches!(self, AppError::VaultNotFound(_) | AppError::DocumentNotInVault(_))
    }

    pub fn problem(&self) -> (u16, &'static str, &'static str) {
        match self {
            AppError::Unauthorized(_) => (401, "unauthorized", "Not authenticated"),
            AppError::Validation(_) => (400, "validation-error", "Invalid data"),
            AppError::VaultNotFound(_) | AppError::DocumentNotInVault(_) => (404, "vault-not-found", "Vault not found"),
            AppError::DocumentNotFound(_) => (404, "document-not-found", "Document not found"),
            AppError::FolderNotFound(_) => (404, "folder-not-found", "Folder not found"),
            AppError::UserNotFound(_) => (404, "user-not-found", "User not found"),
            AppError::AccessDenied(_) => (403, "access-denied", "Access denied"),
            AppError::PathConflict(_) => (409, "path-conflict", "Path already in use"),
            AppError::FolderNotEmpty(_) => (400, "folder-not-empty", "Folder not empty"),
            AppError::QuotaExceeded(_) => (413, "quota-exceeded", "Storage quota exceeded"),
            AppError::StorageUnavailable => (507, "storage-unavailable", "Not enough storage on the server"),
            AppError::TooManyRequests => (429, "rate-limited", "Too many requests"),
            AppError::IdentityProvider(_) => (502, "identity-provider", "Identity provider error"),
            AppError::BadArgument(_) | AppError::Db(_) | AppError::Io(_) | AppError::Internal(_) => {
                (500, "internal-error", "Internal error")
            }
        }
    }
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let (status, kind, title) = self.problem();
        let detail = match &self {
            // Jamais le detail d'une erreur interne : il peut porter du SQL ou un chemin.
            AppError::Db(e) => {
                tracing::error!(error = %e, "erreur de base");
                "Erreur interne.".to_string()
            }
            AppError::Io(e) => {
                tracing::error!(error = %e, "erreur d'entree/sortie");
                "Erreur interne.".to_string()
            }
            AppError::Internal(e) => {
                tracing::error!(error = %e, "erreur interne");
                "Erreur interne.".to_string()
            }
            other => other.to_string(),
        };
        let body = json!({
            "type": format!("https://errors.app/{kind}"),
            "title": title,
            "status": status,
            "detail": detail,
        });
        let mut res = (StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR), axum::Json(body)).into_response();
        res.headers_mut().insert(header::CONTENT_TYPE, HeaderValue::from_static("application/problem+json"));
        if status == 401 {
            res.headers_mut().insert(header::WWW_AUTHENTICATE, HeaderValue::from_static("Bearer"));
        }
        res
    }
}

/// Erreur au format du protocole du pair indexeur : { error: { code, message } }.
pub fn indexer_error_json(code: &str, message: &str) -> serde_json::Value {
    json!({ "error": { "code": code, "message": message } })
}

/// Reponse JSON brute (texte deja forme) avec un statut.
pub fn raw_json(status: u16, body: String) -> Response {
    let mut res = Response::new(axum::body::Body::from(body));
    *res.status_mut() = StatusCode::from_u16(status).unwrap_or(StatusCode::OK);
    res.headers_mut()
        .insert(header::CONTENT_TYPE, HeaderValue::from_static("application/json; charset=utf-8"));
    res
}
