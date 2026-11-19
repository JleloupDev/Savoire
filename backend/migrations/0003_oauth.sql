-- SPDX-License-Identifier: AGPL-3.0-or-later
-- SPDX-FileCopyrightText: 2026 Jean Leloup
--
-- OAuth pour le MCP (ChatGPT, Claude.ai), ADR-033 : Savoire est le serveur
-- d'autorisation de /api/mcp. Clients enregistres (RFC 7591) ou decrits par
-- une adresse (Client ID Metadata Document), demandes en attente de l'ecran
-- d'accord, codes a usage unique, acces accordes (agent, vaults) et jetons.
-- Codes et jetons : seulement leur empreinte SHA-256.

CREATE TABLE oauth_clients (
    client_id character varying(512) PRIMARY KEY,
    client_name character varying(200) NOT NULL,
    redirect_uris jsonb NOT NULL,
    kind character varying(8) NOT NULL,
    created_at timestamp with time zone NOT NULL,
    last_used_at timestamp with time zone
);

-- Une demande d'autorisation qui attend l'ecran d'accord (quelques minutes).
CREATE TABLE oauth_requests (
    id character varying(64) PRIMARY KEY,
    client_id character varying(512) NOT NULL,
    redirect_uri text NOT NULL,
    state text,
    code_challenge character varying(128) NOT NULL,
    scope text,
    created_at timestamp with time zone NOT NULL,
    expires_at timestamp with time zone NOT NULL
);

-- Un acces accorde a un client : la personne, l'agent porte, les vaults.
CREATE TABLE oauth_grants (
    id character varying(64) PRIMARY KEY,
    user_id text NOT NULL,
    client_id character varying(512) NOT NULL,
    client_name character varying(200) NOT NULL,
    agent_id character varying(64),
    vault_ids text,
    created_at timestamp with time zone NOT NULL,
    last_used_at timestamp with time zone,
    revoked_at timestamp with time zone
);
CREATE INDEX "IX_oauth_grants_user_id" ON oauth_grants (user_id);

-- Code d'autorisation (usage unique, 5 minutes) : l'acces qu'il ouvrira.
CREATE TABLE oauth_codes (
    code_hash character varying(64) PRIMARY KEY,
    client_id character varying(512) NOT NULL,
    redirect_uri text NOT NULL,
    code_challenge character varying(128) NOT NULL,
    user_id text NOT NULL,
    agent_id character varying(64),
    vault_ids text,
    client_name character varying(200) NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    used_at timestamp with time zone
);

-- Jetons d'acces (une heure) et de renouvellement (30 jours, remplaces a chaque usage).
CREATE TABLE oauth_tokens (
    token_hash character varying(64) PRIMARY KEY,
    grant_id character varying(64) NOT NULL,
    kind character varying(8) NOT NULL,
    expires_at timestamp with time zone NOT NULL
);
CREATE INDEX "IX_oauth_tokens_grant_id" ON oauth_tokens (grant_id);
