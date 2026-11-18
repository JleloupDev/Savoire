// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Agents IA (ADR-033) : agents declares, accords en attente, journal des
// actions externes, consommation par jour. Voir migrations/0002_agents.sql.

use serde_json::Value;
use sqlx::{PgConnection, Row};

use crate::domain::{Ts, now};
use crate::error::AppResult;

#[derive(Debug, Clone)]
pub struct AgentRow {
    pub id: String,
    pub owner_id: String,
    pub vault_id: Option<String>,
    pub name: String,
    /// L'AgentDefinition de plugin-api (sans id, proprietaire ni dates).
    pub definition: Value,
    pub created_at: Ts,
    pub updated_at: Ts,
}

const AGENT_COLS: &str = "id, owner_id, vault_id, name, definition, created_at, updated_at";

fn agent_row(r: &sqlx::postgres::PgRow) -> AgentRow {
    AgentRow {
        id: r.get("id"),
        owner_id: r.get("owner_id"),
        vault_id: r.get("vault_id"),
        name: r.get("name"),
        definition: r.get("definition"),
        created_at: r.get("created_at"),
        updated_at: r.get("updated_at"),
    }
}

pub async fn get(c: &mut PgConnection, id: &str) -> AppResult<Option<AgentRow>> {
    let r = sqlx::query(sqlx::AssertSqlSafe(format!("SELECT {AGENT_COLS} FROM agents WHERE id = $1"))).bind(id).fetch_optional(&mut *c).await?;
    Ok(r.as_ref().map(agent_row))
}

/// Les agents de la personne, et ceux des vaults dont elle est membre.
pub async fn list_for(c: &mut PgConnection, user_id: &str, vault_ids: &[String]) -> AppResult<Vec<AgentRow>> {
    let rows = sqlx::query(sqlx::AssertSqlSafe(format!(
        "SELECT {AGENT_COLS} FROM agents WHERE (owner_id = $1 AND vault_id IS NULL) OR vault_id = ANY($2) ORDER BY name, id"
    )))
    .bind(user_id)
    .bind(vault_ids)
    .fetch_all(&mut *c)
    .await?;
    Ok(rows.iter().map(agent_row).collect())
}

pub async fn insert(c: &mut PgConnection, a: &AgentRow) -> AppResult<()> {
    sqlx::query(sqlx::AssertSqlSafe(format!("INSERT INTO agents ({AGENT_COLS}) VALUES ($1, $2, $3, $4, $5, $6, $7)")))
        .bind(&a.id)
        .bind(&a.owner_id)
        .bind(&a.vault_id)
        .bind(&a.name)
        .bind(&a.definition)
        .bind(a.created_at)
        .bind(a.updated_at)
        .execute(&mut *c)
        .await?;
    Ok(())
}

pub async fn update(c: &mut PgConnection, a: &AgentRow) -> AppResult<()> {
    sqlx::query("UPDATE agents SET vault_id = $2, name = $3, definition = $4, updated_at = $5 WHERE id = $1")
        .bind(&a.id)
        .bind(&a.vault_id)
        .bind(&a.name)
        .bind(&a.definition)
        .bind(a.updated_at)
        .execute(&mut *c)
        .await?;
    Ok(())
}

pub async fn delete(c: &mut PgConnection, id: &str) -> AppResult<()> {
    sqlx::query("DELETE FROM agents WHERE id = $1").bind(id).execute(&mut *c).await?;
    Ok(())
}

// ── Consommation ─────────────────────────────────────────────────────────────

pub struct UsageDelta {
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub runs: i64,
    pub calls: i64,
}

pub async fn usage_add(c: &mut PgConnection, agent_id: &str, user_id: &str, d: &UsageDelta) -> AppResult<()> {
    sqlx::query(
        "INSERT INTO agent_usage (agent_id, user_id, day, input_tokens, output_tokens, runs, calls)
         VALUES ($1, $2, (now() AT TIME ZONE 'utc')::date, $3, $4, $5, $6)
         ON CONFLICT (agent_id, user_id, day) DO UPDATE SET
           input_tokens = agent_usage.input_tokens + EXCLUDED.input_tokens,
           output_tokens = agent_usage.output_tokens + EXCLUDED.output_tokens,
           runs = agent_usage.runs + EXCLUDED.runs,
           calls = agent_usage.calls + EXCLUDED.calls",
    )
    .bind(agent_id)
    .bind(user_id)
    .bind(d.input_tokens)
    .bind(d.output_tokens)
    .bind(d.runs)
    .bind(d.calls)
    .execute(&mut *c)
    .await?;
    Ok(())
}

/// Consommation de la personne sur les `days` derniers jours.
pub async fn usage_for(c: &mut PgConnection, user_id: &str, days: i32) -> AppResult<Vec<Value>> {
    let rows = sqlx::query(
        "SELECT agent_id, to_char(day, 'YYYY-MM-DD') AS day, input_tokens, output_tokens, runs, calls FROM agent_usage
          WHERE user_id = $1 AND day > (now() AT TIME ZONE 'utc')::date - $2 ORDER BY day DESC, agent_id",
    )
    .bind(user_id)
    .bind(days)
    .fetch_all(&mut *c)
    .await?;
    Ok(rows
        .iter()
        .map(|r| {
            serde_json::json!({
                "agentId": r.get::<String, _>("agent_id"), "day": r.get::<String, _>("day"),
                "inputTokens": r.get::<i64, _>("input_tokens"), "outputTokens": r.get::<i64, _>("output_tokens"),
                "runs": r.get::<i64, _>("runs"), "calls": r.get::<i64, _>("calls"),
            })
        })
        .collect())
}

// ── Accords en attente ───────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct ApprovalRow {
    pub id: String,
    pub agent_id: String,
    pub user_id: String,
    pub vault_id: String,
    pub tool: String,
    pub args: Value,
    pub summary: String,
    pub status: String,
    pub result: Option<String>,
    pub created_at: Ts,
    pub decided_at: Option<Ts>,
}

const APPROVAL_COLS: &str = "id, agent_id, user_id, vault_id, tool, args, summary, status, result, created_at, decided_at";

fn approval_row(r: &sqlx::postgres::PgRow) -> ApprovalRow {
    ApprovalRow {
        id: r.get("id"),
        agent_id: r.get("agent_id"),
        user_id: r.get("user_id"),
        vault_id: r.get("vault_id"),
        tool: r.get("tool"),
        args: r.get("args"),
        summary: r.get("summary"),
        status: r.get("status"),
        result: r.get("result"),
        created_at: r.get("created_at"),
        decided_at: r.get("decided_at"),
    }
}

pub async fn approval_add(c: &mut PgConnection, a: &ApprovalRow) -> AppResult<()> {
    sqlx::query(sqlx::AssertSqlSafe(format!("INSERT INTO agent_approvals ({APPROVAL_COLS}) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)")))
        .bind(&a.id)
        .bind(&a.agent_id)
        .bind(&a.user_id)
        .bind(&a.vault_id)
        .bind(&a.tool)
        .bind(&a.args)
        .bind(&a.summary)
        .bind(&a.status)
        .bind(&a.result)
        .bind(a.created_at)
        .bind(a.decided_at)
        .execute(&mut *c)
        .await?;
    Ok(())
}

pub async fn approval_get(c: &mut PgConnection, id: &str) -> AppResult<Option<ApprovalRow>> {
    let r = sqlx::query(sqlx::AssertSqlSafe(format!("SELECT {APPROVAL_COLS} FROM agent_approvals WHERE id = $1"))).bind(id).fetch_optional(&mut *c).await?;
    Ok(r.as_ref().map(approval_row))
}

pub async fn approvals_for(c: &mut PgConnection, user_id: &str, limit: i64) -> AppResult<Vec<ApprovalRow>> {
    let rows = sqlx::query(sqlx::AssertSqlSafe(format!(
        "SELECT {APPROVAL_COLS} FROM agent_approvals WHERE user_id = $1 ORDER BY (status = 'pending') DESC, created_at DESC LIMIT $2"
    )))
    .bind(user_id)
    .bind(limit)
    .fetch_all(&mut *c)
    .await?;
    Ok(rows.iter().map(approval_row).collect())
}

/// Passe un accord de « pending » a `status`. Faux : il n'etait plus en attente (decide ailleurs).
pub async fn approval_decide(c: &mut PgConnection, id: &str, status: &str) -> AppResult<bool> {
    let n = sqlx::query("UPDATE agent_approvals SET status = $2, decided_at = $3 WHERE id = $1 AND status = 'pending'")
        .bind(id)
        .bind(status)
        .bind(now())
        .execute(&mut *c)
        .await?
        .rows_affected();
    Ok(n == 1)
}

pub async fn approval_finish(c: &mut PgConnection, id: &str, status: &str, result: &str) -> AppResult<()> {
    sqlx::query("UPDATE agent_approvals SET status = $2, result = $3 WHERE id = $1").bind(id).bind(status).bind(result).execute(&mut *c).await?;
    Ok(())
}

// ── Journal des actions externes ─────────────────────────────────────────────

pub struct ActionRow<'a> {
    pub agent_id: &'a str,
    pub user_id: &'a str,
    pub vault_id: &'a str,
    pub tool: &'a str,
    pub action: &'a str,
    pub mode: &'a str,
    pub status: &'a str,
    pub summary: &'a str,
}

pub async fn action_add(c: &mut PgConnection, a: &ActionRow<'_>) -> AppResult<()> {
    sqlx::query(
        "INSERT INTO agent_actions (id, agent_id, user_id, vault_id, tool, action, mode, status, summary, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)",
    )
    .bind(crate::domain::new_id_n())
    .bind(a.agent_id)
    .bind(a.user_id)
    .bind(a.vault_id)
    .bind(a.tool)
    .bind(a.action)
    .bind(a.mode)
    .bind(a.status)
    .bind(a.summary)
    .bind(now())
    .execute(&mut *c)
    .await?;
    Ok(())
}

pub async fn actions_for(c: &mut PgConnection, user_id: &str, limit: i64) -> AppResult<Vec<Value>> {
    let rows = sqlx::query(
        "SELECT a.id, a.agent_id, coalesce(g.name, a.agent_id) AS agent_name, a.vault_id, a.tool, a.action, a.mode, a.status, a.summary, a.created_at
           FROM agent_actions a LEFT JOIN agents g ON g.id = a.agent_id
          WHERE a.user_id = $1 ORDER BY a.created_at DESC LIMIT $2",
    )
    .bind(user_id)
    .bind(limit)
    .fetch_all(&mut *c)
    .await?;
    Ok(rows
        .iter()
        .map(|r| {
            serde_json::json!({
                "id": r.get::<String, _>("id"), "agentId": r.get::<String, _>("agent_id"), "agentName": r.get::<String, _>("agent_name"),
                "vaultId": r.get::<String, _>("vault_id"), "tool": r.get::<String, _>("tool"), "action": r.get::<String, _>("action"),
                "mode": r.get::<String, _>("mode"), "status": r.get::<String, _>("status"), "summary": r.get::<String, _>("summary"),
                "createdAt": r.get::<Ts, _>("created_at"),
            })
        })
        .collect())
}
