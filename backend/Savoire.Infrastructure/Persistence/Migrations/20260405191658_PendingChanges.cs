using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

#pragma warning disable CA1814 // Prefer jagged arrays over multidimensional

namespace Savoire.Infrastructure.Persistence.Migrations
{
    /// <summary>
    /// Consolidates the work of the former AddRefEnumValues and DocLinkFkToDocumentMeta
    /// orphan migrations (which had no .Designer.cs and were not in the EF chain) into
    /// a single tracked migration:
    ///
    ///   1. Creates six reference/enum lookup tables (ref_vault_roles, ref_permissions,
    ///      ref_resource_types, ref_subject_types, ref_link_types, ref_sync_change_types)
    ///      and seeds them with all valid values.
    ///
    ///   2. Rebuilds vault_members, resource_permissions, share_links, and doc_links
    ///      to add FK constraints to the new ref tables and to document_metas.
    ///      Raw SQL is used throughout because SQLite does not support
    ///      ALTER TABLE ADD CONSTRAINT, and EF Core's AddForeignKey() helper
    ///      runs PRAGMA foreign_keys = 0 on a different connection than the rebuild,
    ///      causing FK checks to fire unexpectedly.
    ///
    ///   3. Adds navigation indexes on the FK columns.
    /// </summary>
    public partial class PendingChanges : Migration
    {
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            // ── 1. Reference tables ──────────────────────────────────────────
            migrationBuilder.Sql("""
                CREATE TABLE ref_resource_types (
                    value       TEXT NOT NULL CONSTRAINT PK_ref_resource_types PRIMARY KEY,
                    description TEXT NOT NULL
                );
                CREATE TABLE ref_permissions (
                    value       TEXT NOT NULL CONSTRAINT PK_ref_permissions PRIMARY KEY,
                    description TEXT NOT NULL
                );
                CREATE TABLE ref_vault_roles (
                    value       TEXT NOT NULL CONSTRAINT PK_ref_vault_roles PRIMARY KEY,
                    description TEXT NOT NULL
                );
                CREATE TABLE ref_link_types (
                    value       TEXT NOT NULL CONSTRAINT PK_ref_link_types PRIMARY KEY,
                    description TEXT NOT NULL
                );
                CREATE TABLE ref_subject_types (
                    value       TEXT NOT NULL CONSTRAINT PK_ref_subject_types PRIMARY KEY,
                    description TEXT NOT NULL
                );
                CREATE TABLE ref_sync_change_types (
                    value       TEXT NOT NULL CONSTRAINT PK_ref_sync_change_types PRIMARY KEY,
                    description TEXT NOT NULL
                );
                """);

            // ── 2. Seed ──────────────────────────────────────────────────────
            migrationBuilder.Sql("""
                INSERT INTO ref_resource_types VALUES
                    ('vault',    'A vault — contains documents and folders.'),
                    ('document', 'A single document within a vault.');
                INSERT INTO ref_permissions VALUES
                    ('read',  'Read-only access to the resource.'),
                    ('write', 'Read and write access to the resource.'),
                    ('admin', 'Full control, including sharing the resource.');
                INSERT INTO ref_vault_roles VALUES
                    ('owner',  'Vault creator — cannot be removed, has all permissions.'),
                    ('editor', 'Can read and write documents.'),
                    ('viewer', 'Read-only access to all documents in the vault.');
                INSERT INTO ref_link_types VALUES
                    ('wikilink', 'Standard wikilink: [[path]]'),
                    ('embed',    'Embedded content: ![[path]]');
                INSERT INTO ref_subject_types VALUES
                    ('user', 'An individual user account.');
                INSERT INTO ref_sync_change_types VALUES
                    ('created',  'Document was created after the sync baseline.'),
                    ('modified', 'Document was modified after the sync baseline.'),
                    ('deleted',  'Document was soft-deleted after the sync baseline.'),
                    ('moved',    'Document was moved (reserved — not yet produced by the server).');
                """);

            // ── 3. Rebuild vault_members → ref_vault_roles ──────────────────
            migrationBuilder.Sql("""
                CREATE TABLE vault_members_new (
                    vault_id  TEXT NOT NULL,
                    user_id   TEXT NOT NULL,
                    role      TEXT NOT NULL,
                    joined_at TEXT NOT NULL,
                    CONSTRAINT PK_vault_members PRIMARY KEY (vault_id, user_id),
                    CONSTRAINT FK_vault_members_vault FOREIGN KEY (vault_id) REFERENCES vaults(id)              ON DELETE CASCADE,
                    CONSTRAINT FK_vault_members_role  FOREIGN KEY (role)     REFERENCES ref_vault_roles(value)  ON DELETE RESTRICT
                );
                INSERT INTO vault_members_new SELECT vault_id, user_id, role, joined_at FROM vault_members;
                DROP TABLE vault_members;
                ALTER TABLE vault_members_new RENAME TO vault_members;
                CREATE UNIQUE INDEX IX_vault_members_unique ON vault_members (vault_id, user_id);
                CREATE INDEX IX_vault_members_role ON vault_members (role);
                """);

            // ── 4. Rebuild resource_permissions → ref_* ──────────────────────
            migrationBuilder.Sql("""
                CREATE TABLE resource_permissions_new (
                    id            TEXT NOT NULL,
                    resource_type TEXT NOT NULL,
                    resource_id   TEXT NOT NULL,
                    subject_type  TEXT NOT NULL,
                    subject_id    TEXT NOT NULL,
                    permission    TEXT NOT NULL,
                    granted_by    TEXT NOT NULL,
                    granted_at    TEXT NOT NULL,
                    expires_at    TEXT NULL,
                    CONSTRAINT PK_resource_permissions PRIMARY KEY (id),
                    CONSTRAINT FK_rp_resource_type FOREIGN KEY (resource_type) REFERENCES ref_resource_types(value) ON DELETE RESTRICT,
                    CONSTRAINT FK_rp_permission    FOREIGN KEY (permission)    REFERENCES ref_permissions(value)    ON DELETE RESTRICT,
                    CONSTRAINT FK_rp_subject_type  FOREIGN KEY (subject_type)  REFERENCES ref_subject_types(value)  ON DELETE RESTRICT
                );
                INSERT INTO resource_permissions_new
                    SELECT id, resource_type, resource_id, subject_type, subject_id, permission, granted_by, granted_at, expires_at
                    FROM resource_permissions;
                DROP TABLE resource_permissions;
                ALTER TABLE resource_permissions_new RENAME TO resource_permissions;
                CREATE UNIQUE INDEX IX_resource_permissions_unique    ON resource_permissions (resource_type, resource_id, subject_type, subject_id);
                CREATE        INDEX IX_resource_permissions_resource  ON resource_permissions (resource_type, resource_id);
                CREATE        INDEX IX_resource_permissions_permission ON resource_permissions (permission);
                CREATE        INDEX IX_resource_permissions_subject_type ON resource_permissions (subject_type);
                """);

            // ── 5. Rebuild share_links → ref_* ───────────────────────────────
            migrationBuilder.Sql("""
                CREATE TABLE share_links_new (
                    id            TEXT NOT NULL,
                    token         TEXT NOT NULL,
                    resource_type TEXT NOT NULL,
                    resource_id   TEXT NOT NULL,
                    permission    TEXT NOT NULL,
                    created_by    TEXT NOT NULL,
                    created_at    TEXT NOT NULL,
                    expires_at    TEXT NULL,
                    revoked_at    TEXT NULL,
                    CONSTRAINT PK_share_links PRIMARY KEY (id),
                    CONSTRAINT FK_sl_resource_type FOREIGN KEY (resource_type) REFERENCES ref_resource_types(value) ON DELETE RESTRICT,
                    CONSTRAINT FK_sl_permission    FOREIGN KEY (permission)    REFERENCES ref_permissions(value)    ON DELETE RESTRICT
                );
                INSERT INTO share_links_new
                    SELECT id, token, resource_type, resource_id, permission, created_by, created_at, expires_at, revoked_at
                    FROM share_links;
                DROP TABLE share_links;
                ALTER TABLE share_links_new RENAME TO share_links;
                CREATE UNIQUE INDEX IX_share_links_token      ON share_links (token);
                CREATE        INDEX IX_share_links_resource   ON share_links (resource_type, resource_id);
                CREATE        INDEX IX_share_links_permission ON share_links (permission);
                """);

            // ── 6. Rebuild doc_links → document_metas + ref_link_types ───────
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
                CREATE INDEX IX_doc_links_link_type    ON doc_links (link_type);
                """);
        }

        protected override void Down(MigrationBuilder migrationBuilder)
        {
            // Restore doc_links without the document_metas FK
            migrationBuilder.Sql("""
                CREATE TABLE doc_links_old (
                    id TEXT NOT NULL, source_id TEXT NOT NULL, vault_id TEXT NOT NULL,
                    target_id TEXT NULL, target_path TEXT NOT NULL, link_type TEXT NOT NULL DEFAULT 'wikilink',
                    CONSTRAINT PK_doc_links PRIMARY KEY (id)
                );
                INSERT INTO doc_links_old SELECT id, source_id, vault_id, target_id, target_path, link_type FROM doc_links;
                DROP TABLE doc_links;
                ALTER TABLE doc_links_old RENAME TO doc_links;
                CREATE INDEX idx_doc_links_source ON doc_links (source_id);
                CREATE INDEX idx_doc_links_target ON doc_links (target_id);
                CREATE INDEX idx_doc_links_target_path ON doc_links (vault_id, target_path);
                """);

            migrationBuilder.Sql("""
                CREATE TABLE share_links_old (
                    id TEXT NOT NULL, token TEXT NOT NULL, resource_type TEXT NOT NULL,
                    resource_id TEXT NOT NULL, permission TEXT NOT NULL, created_by TEXT NOT NULL,
                    created_at TEXT NOT NULL, expires_at TEXT NULL, revoked_at TEXT NULL,
                    CONSTRAINT PK_share_links PRIMARY KEY (id)
                );
                INSERT INTO share_links_old SELECT id, token, resource_type, resource_id, permission, created_by, created_at, expires_at, revoked_at FROM share_links;
                DROP TABLE share_links;
                ALTER TABLE share_links_old RENAME TO share_links;
                CREATE UNIQUE INDEX IX_share_links_token    ON share_links (token);
                CREATE        INDEX IX_share_links_resource ON share_links (resource_type, resource_id);
                """);

            migrationBuilder.Sql("""
                CREATE TABLE resource_permissions_old (
                    id TEXT NOT NULL, resource_type TEXT NOT NULL, resource_id TEXT NOT NULL,
                    subject_type TEXT NOT NULL, subject_id TEXT NOT NULL, permission TEXT NOT NULL,
                    granted_by TEXT NOT NULL, granted_at TEXT NOT NULL, expires_at TEXT NULL,
                    CONSTRAINT PK_resource_permissions PRIMARY KEY (id)
                );
                INSERT INTO resource_permissions_old SELECT id, resource_type, resource_id, subject_type, subject_id, permission, granted_by, granted_at, expires_at FROM resource_permissions;
                DROP TABLE resource_permissions;
                ALTER TABLE resource_permissions_old RENAME TO resource_permissions;
                CREATE UNIQUE INDEX IX_resource_permissions_unique   ON resource_permissions (resource_type, resource_id, subject_type, subject_id);
                CREATE        INDEX IX_resource_permissions_resource ON resource_permissions (resource_type, resource_id);
                """);

            migrationBuilder.Sql("""
                CREATE TABLE vault_members_old (
                    vault_id TEXT NOT NULL, user_id TEXT NOT NULL, role TEXT NOT NULL, joined_at TEXT NOT NULL,
                    CONSTRAINT PK_vault_members PRIMARY KEY (vault_id, user_id),
                    CONSTRAINT FK_vault_members_vault FOREIGN KEY (vault_id) REFERENCES vaults(id) ON DELETE CASCADE
                );
                INSERT INTO vault_members_old SELECT vault_id, user_id, role, joined_at FROM vault_members;
                DROP TABLE vault_members;
                ALTER TABLE vault_members_old RENAME TO vault_members;
                CREATE UNIQUE INDEX IX_vault_members_unique ON vault_members (vault_id, user_id);
                """);

            migrationBuilder.DropTable("ref_sync_change_types");
            migrationBuilder.DropTable("ref_subject_types");
            migrationBuilder.DropTable("ref_link_types");
            migrationBuilder.DropTable("ref_vault_roles");
            migrationBuilder.DropTable("ref_permissions");
            migrationBuilder.DropTable("ref_resource_types");
        }
    }
}
