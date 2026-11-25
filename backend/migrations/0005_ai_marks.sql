-- SPDX-License-Identifier: AGPL-3.0-or-later
-- SPDX-FileCopyrightText: 2026 Jean Leloup
--
-- Marques pour l'IA : ce que la personne designe a ChatGPT, Claude ou
-- l'assistant dans ses notes. Personnelles : jamais ecrites dans la note.
--   pin       : une epingle nommee (un passage ou un endroit qui reste) ;
--   highlight : un passage surligne « pour l'IA », jusqu'a ce qu'elle l'efface.
-- anchor : { docId, start, end, quote, prefix, suffix } (positions relatives
-- Yjs en base64 : le passage suit les modifications de la note).
CREATE TABLE ai_marks (
    id character varying(64) PRIMARY KEY,
    user_id text NOT NULL,
    vault_id text NOT NULL,
    doc_id text NOT NULL,
    kind character varying(16) NOT NULL,
    label character varying(200) NOT NULL DEFAULT '',
    path text NOT NULL DEFAULT '',
    anchor jsonb NOT NULL,
    created_at timestamp with time zone NOT NULL
);
CREATE INDEX "IX_ai_marks_user_vault_doc" ON ai_marks (user_id, vault_id, doc_id);
