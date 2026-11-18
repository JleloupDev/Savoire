// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Une connexion WebSocket a un hub : authentification (jeton en
// access_token), boucle de lecture, appels traites un par un (comme SignalR),
// fermeture a l'expiration du jeton (M7) : le client se reconnecte avec un
// jeton neuf, et ses droits sont reverifies.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::extract::ws::{Message, WebSocket};
use axum::extract::{Path, State, WebSocketUpgrade};
use axum::response::{IntoResponse, Response};
use futures::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio::sync::mpsc;

use super::{Conn, ConnItems, HubKind, hub_code, hubs};
use crate::auth::MaybeAuth;
use crate::error::AppError;
use crate::state::AppState;

/// 4 Mio : l'etat CRDT complet d'un document (envoi d'un vault, compaction, gros dessins).
const MAX_MESSAGE: usize = 4 * 1024 * 1024;

pub async fn upgrade(
    State(st): State<AppState>,
    Path(name): Path<String>,
    MaybeAuth(principal): MaybeAuth,
    ws: Result<WebSocketUpgrade, axum::extract::ws::rejection::WebSocketUpgradeRejection>,
) -> Response {
    let Some(kind) = HubKind::parse(&name) else { return axum::http::StatusCode::NOT_FOUND.into_response() };
    let Some(principal) = principal else { return AppError::Unauthorized("Not authenticated.".into()).into_response() };
    // Sans demande de WebSocket : le client verifie son jeton avant d'ouvrir
    // la connexion (un navigateur ne montre pas le statut d'un refus).
    let Ok(ws) = ws else { return axum::Json(json!({ "protocol": "savoire-hub", "version": 1 })).into_response() };
    ws.max_message_size(MAX_MESSAGE + 64 * 1024)
        .on_upgrade(move |socket| run(st, kind, principal, socket))
}

async fn run(st: AppState, kind: HubKind, principal: crate::auth::Principal, socket: WebSocket) {
    let conn_id = uuid::Uuid::new_v4().simple().to_string();
    let (tx, mut rx) = mpsc::unbounded_channel::<String>();
    let expires = principal.expires_at;
    let conn = Arc::new(Conn { tx: tx.clone(), principal, items: Mutex::new(ConnItems::default()) });
    st.realtime.hub(kind).conns.insert(conn_id.clone(), conn.clone());
    let (mut sink, mut stream) = socket.split();
    let _ = tx.send(json!({ "t": "hello", "connectionId": conn_id }).to_string());

    let writer = tokio::spawn(async move {
        while let Some(msg) = rx.recv().await {
            if sink.send(Message::Text(msg.into())).await.is_err() {
                break;
            }
        }
        let _ = sink.close().await;
    });

    let expiry = async {
        match expires {
            Some(at) => {
                let left = (at - crate::domain::now()).to_std().unwrap_or(Duration::ZERO);
                tokio::time::sleep(left).await
            }
            None => std::future::pending::<()>().await,
        }
    };
    tokio::pin!(expiry);

    loop {
        tokio::select! {
            _ = &mut expiry => {
                tracing::info!(connection = %conn_id, "Jeton expire : connexion fermee");
                break;
            }
            msg = stream.next() => {
                let Some(Ok(msg)) = msg else { break };
                let text = match msg {
                    Message::Text(t) => t.to_string(),
                    Message::Close(_) => break,
                    _ => continue,
                };
                if text.len() > MAX_MESSAGE {
                    continue;
                }
                handle_frame(&st, kind, &conn_id, &conn, &text).await;
            }
        }
    }

    hubs::disconnected(&st, kind, &conn_id).await;
    drop(tx);
    st.realtime.forget(kind, &conn_id);
    drop(conn);
    let _ = tokio::time::timeout(Duration::from_secs(2), writer).await;
}

async fn handle_frame(st: &AppState, kind: HubKind, conn_id: &str, conn: &Arc<Conn>, text: &str) {
    let Ok(frame) = serde_json::from_str::<Value>(text) else { return };
    match frame.get("t").and_then(Value::as_str) {
        Some("ping") => {
            let _ = conn.tx.send(json!({ "t": "pong" }).to_string());
        }
        Some("invoke") => {
            let id = frame.get("id").cloned().filter(|v| !v.is_null());
            let method = frame.get("m").and_then(Value::as_str).unwrap_or("").to_string();
            let args = frame.get("a").and_then(Value::as_array).cloned().unwrap_or_default();
            // Limite d'appels par compte (ou par lien), Limits:HubCallsPerMinute.
            let key = if conn.principal.sub.is_empty() { conn_id.to_string() } else { conn.principal.sub.clone() };
            let result = match st.realtime.limiter.try_acquire(&key, st.limits().hub_calls_per_minute) {
                Err(_) => Err(AppError::TooManyRequests),
                Ok(()) => hubs::invoke(st, kind, conn_id, conn, &method, &args).await,
            };
            let Some(id) = id else {
                if let Err(e) = result {
                    log_refusal(kind, &method, &e);
                }
                return;
            };
            let reply = match result {
                Ok(v) => json!({ "t": "result", "id": id, "r": v }),
                Err(e) => {
                    log_refusal(kind, &method, &e);
                    let base = format!("An unexpected error occurred invoking '{method}' on the server.");
                    let msg = match hub_code(&e) {
                        Some(code) => format!("{base} HubException: {code}"),
                        None => base,
                    };
                    json!({ "t": "error", "id": id, "e": msg })
                }
            };
            let _ = conn.tx.send(reply.to_string());
        }
        _ => {}
    }
}

fn log_refusal(kind: HubKind, method: &str, e: &AppError) {
    match hub_code(e) {
        Some(code) => tracing::warn!(hub = ?kind, method, code, "Hub : appel refuse"),
        None => tracing::error!(hub = ?kind, method, error = %e, "Hub : appel en echec"),
    }
}
