// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Savoire.Infrastructure.Persistence.Migrations
{
    /// <summary>
    /// Moves doc_links.source_id FK from documents(id) to document_metas(document_id).
    /// DocLink is now owned by DocumentMeta — both are produced by the same indexing
    /// pipeline and share the same ID value (source_id == document_id).
    ///
    /// SQLite does not support ALTER TABLE ADD CONSTRAINT, so the table is rebuilt.
    /// The AddRefEnumValues migration already rebuilt doc_links with a FK to ref_link_types;
    /// this migration preserves that FK and adds the new one to document_metas.
    /// </summary>
    public partial class DocLinkFkToDocumentMeta : Migration
    {
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.Sql("""
                CREATE TABLE doc_links_new (
                    id          TEXT NOT NULL,
                    source_id   TEXT NOT NULL,
                    vault_id    TEXT NOT NULL,
                    target_id   TEXT NULL,
                    target_path TEXT NOT NULL,
                    link_type   TEXT NOT NULL DEFAULT 'wikilink',
                    CONSTRAINT PK_doc_links          PRIMARY KEY (id),
                    CONSTRAINT FK_doc_links_meta      FOREIGN KEY (source_id) REFERENCES document_metas(document_id) ON DELETE CASCADE,
                    CONSTRAINT FK_doc_links_link_type FOREIGN KEY (link_type) REFERENCES ref_link_types(value)       ON DELETE RESTRICT
                );
                INSERT INTO doc_links_new SELECT id, source_id, vault_id, target_id, target_path, link_type FROM doc_links;
                DROP TABLE doc_links;
                ALTER TABLE doc_links_new RENAME TO doc_links;
                CREATE INDEX idx_doc_links_source      ON doc_links (source_id);
                CREATE INDEX idx_doc_links_target      ON doc_links (target_id);
                CREATE INDEX idx_doc_links_target_path ON doc_links (vault_id, target_path);
                """);
        }

        protected override void Down(MigrationBuilder migrationBuilder)
        {
            // Restore without the document_metas FK (matches AddRefEnumValues state)
            migrationBuilder.Sql("""
                CREATE TABLE doc_links_old (
                    id          TEXT NOT NULL,
                    source_id   TEXT NOT NULL,
                    vault_id    TEXT NOT NULL,
                    target_id   TEXT NULL,
                    target_path TEXT NOT NULL,
                    link_type   TEXT NOT NULL DEFAULT 'wikilink',
                    CONSTRAINT PK_doc_links          PRIMARY KEY (id),
                    CONSTRAINT FK_doc_links_link_type FOREIGN KEY (link_type) REFERENCES ref_link_types(value) ON DELETE RESTRICT
                );
                INSERT INTO doc_links_old SELECT id, source_id, vault_id, target_id, target_path, link_type FROM doc_links;
                DROP TABLE doc_links;
                ALTER TABLE doc_links_old RENAME TO doc_links;
                CREATE INDEX idx_doc_links_source      ON doc_links (source_id);
                CREATE INDEX idx_doc_links_target      ON doc_links (target_id);
                CREATE INDEX idx_doc_links_target_path ON doc_links (vault_id, target_path);
                """);
        }
    }
}
