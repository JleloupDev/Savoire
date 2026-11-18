-- SPDX-License-Identifier: AGPL-3.0-or-later
-- SPDX-FileCopyrightText: 2026 Jean Leloup
--
-- Agents IA (ADR-033) : agents declares, jeton rattache a un agent, accords
-- en attente, journal des actions externes, consommation par jour, auteur
-- de chaque operation enregistree.

-- Un agent declare. vault_id : agent du vault (partage par ses membres) ;
-- null : agent personnel. Le reste (droits, portee, budget...) est en JSON,
-- au format AgentDefinition de plugin-api.
CREATE TABLE agents (
    id character varying(64) PRIMARY KEY,
    owner_id text NOT NULL,
    vault_id text,
    name character varying(100) NOT NULL,
    definition jsonb NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL
);
CREATE INDEX "IX_agents_owner_id" ON agents (owner_id);
CREATE INDEX "IX_agents_vault_id" ON agents (vault_id);

-- Le jeton personnel que porte une IA externe (ChatGPT...). Null : lecture seule, comme avant.
ALTER TABLE access_tokens ADD COLUMN agent_id character varying(64);

-- Une action « demander » venue de l'exterieur : elle attend l'accord de la personne.
CREATE TABLE agent_approvals (
    id character varying(64) PRIMARY KEY,
    agent_id character varying(64) NOT NULL,
    user_id text NOT NULL,
    vault_id text NOT NULL,
    tool character varying(64) NOT NULL,
    args jsonb NOT NULL,
    summary text NOT NULL,
    status character varying(16) NOT NULL,
    result text,
    created_at timestamp with time zone NOT NULL,
    decided_at timestamp with time zone
);
CREATE INDEX "IX_agent_approvals_user_status" ON agent_approvals (user_id, status);

-- Ce qu'une IA externe a fait (ou tente) par le serveur.
CREATE TABLE agent_actions (
    id character varying(64) PRIMARY KEY,
    agent_id character varying(64) NOT NULL,
    user_id text NOT NULL,
    vault_id text NOT NULL,
    tool character varying(64) NOT NULL,
    action character varying(16) NOT NULL,
    mode character varying(16) NOT NULL,
    status character varying(16) NOT NULL,
    summary text NOT NULL,
    created_at timestamp with time zone NOT NULL
);
CREATE INDEX "IX_agent_actions_user_created" ON agent_actions (user_id, created_at DESC);

-- Consommation par agent, personne et jour (tokens comptes par l'appli, appels d'outils).
CREATE TABLE agent_usage (
    agent_id character varying(64) NOT NULL,
    user_id text NOT NULL,
    day date NOT NULL,
    input_tokens bigint NOT NULL DEFAULT 0,
    output_tokens bigint NOT NULL DEFAULT 0,
    runs bigint NOT NULL DEFAULT 0,
    calls bigint NOT NULL DEFAULT 0,
    PRIMARY KEY (agent_id, user_id, day)
);

-- Qui a produit chaque operation : { "id", "name" } d'une personne, ou
-- { "id", "name", "agentId", "agentName" } d'un agent qui agit pour elle.
ALTER TABLE operations_log ADD COLUMN author jsonb;
