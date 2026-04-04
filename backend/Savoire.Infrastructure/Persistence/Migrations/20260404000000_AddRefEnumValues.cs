// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Savoire.Infrastructure.Persistence.Migrations
{
    /// <summary>
    /// Adds one reference table per enum, seeded with all valid values.
    /// FK constraints are added to the tables that reference each enum:
    ///   vault_members.role              → ref_vault_roles.value
    ///   resource_permissions.resource_type → ref_resource_types.value
    ///   resource_permissions.permission    → ref_permissions.value
    ///   resource_permissions.subject_type  → ref_subject_types.value
    ///   share_links.resource_type          → ref_resource_types.value
    ///   share_links.permission             → ref_permissions.value
    ///   doc_links.link_type                → ref_link_types.value
    ///   ref_sync_change_types has no FK (values only appear in API responses).
    ///
    /// NOTE: SQLite does not support ALTER TABLE ADD CONSTRAINT.
    /// FK enforcement is achieved by rebuilding each affected table.
    /// </summary>
    public partial class AddRefEnumValues : Migration
    {
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            // - 1. Create reference tables ------------------

            migrationBuilder.CreateTable(
                name: "ref_resource_types",
                columns: table => new
                {
                    value       = table.Column<string>(type: "TEXT", nullable: false),
                    description = table.Column<string>(type: "TEXT", nullable: false)
                },
                constraints: table => table.PrimaryKey("PK_ref_resource_types", x => x.value));

            migrationBuilder.CreateTable(
                name: "ref_permissions",
                columns: table => new
                {
                    value       = table.Column<string>(type: "TEXT", nullable: false),
                    description = table.Column<string>(type: "TEXT", nullable: false)
                },
                constraints: table => table.PrimaryKey("PK_ref_permissions", x => x.value));

            migrationBuilder.CreateTable(
                name: "ref_vault_roles",
                columns: table => new
                {
                    value       = table.Column<string>(type: "TEXT", nullable: false),
                    description = table.Column<string>(type: "TEXT", nullable: false)
                },
                constraints: table => table.PrimaryKey("PK_ref_vault_roles", x => x.value));

            migrationBuilder.CreateTable(
                name: "ref_link_types",
                columns: table => new
                {
                    value       = table.Column<string>(type: "TEXT", nullable: false),
                    description = table.Column<string>(type: "TEXT", nullable: false)
                },
                constraints: table => table.PrimaryKey("PK_ref_link_types", x => x.value));

            migrationBuilder.CreateTable(
                name: "ref_subject_types",
                columns: table => new
                {
                    value       = table.Column<string>(type: "TEXT", nullable: false),
                    description = table.Column<string>(type: "TEXT", nullable: false)
                },
                constraints: table => table.PrimaryKey("PK_ref_subject_types", x => x.value));

            migrationBuilder.CreateTable(
                name: "ref_sync_change_types",
                columns: table => new
                {
                    value       = table.Column<string>(type: "TEXT", nullable: false),
                    description = table.Column<string>(type: "TEXT", nullable: false)
                },
                constraints: table => table.PrimaryKey("PK_ref_sync_change_types", x => x.value));

            // - 2. Seed ---------------------------─

            migrationBuilder.InsertData("ref_resource_types",
                columns: new[] { "value", "description" },
                values: new object[,]
                {
                    { "vault",    "A vault — contains documents and folders." },
                    { "document", "A single document within a vault." }
                });

            migrationBuilder.InsertData("ref_permissions",
                columns: new[] { "value", "description" },
                values: new object[,]
                {
                    { "read",  "Read-only access to the resource." },
                    { "write", "Read and write access to the resource." },
                    { "admin", "Full control, including sharing the resource." }
                });

            migrationBuilder.InsertData("ref_vault_roles",
                columns: new[] { "value", "description" },
                values: new object[,]
                {
                    { "owner",  "Vault creator — cannot be removed, has all permissions." },
                    { "editor", "Can read and write documents." },
                    { "viewer", "Read-only access to all documents in the vault." }
                });

            migrationBuilder.InsertData("ref_link_types",
                columns: new[] { "value", "description" },
                values: new object[,]
                {
                    { "wikilink", "Standard wikilink: [[path]]" },
                    { "embed",    "Embedded content: ![[path]]" }
                });

            migrationBuilder.InsertData("ref_subject_types",
                columns: new[] { "value", "description" },
                values: new object[,]
                {
                    { "user", "An individual user account." }
                });

            migrationBuilder.InsertData("ref_sync_change_types",
                columns: new[] { "value", "description" },
                values: new object[,]
                {
                    { "created",  "Document was created after the sync baseline." },
                    { "modified", "Document was modified after the sync baseline." },
                    { "deleted",  "Document was soft-deleted after the sync baseline." },
                    { "moved",    "Document was moved (reserved — not yet produced by the server)." }
                });

            // - 3. Rebuild vault_members with FK → ref_vault_roles ------

            migrationBuilder.Sql("""
                CREATE TABLE vault_members_new (
                    vault_id  TEXT NOT NULL,
                    user_id   TEXT NOT NULL,
                    role      TEXT NOT NULL,
                    joined_at TEXT NOT NULL,
                    CONSTRAINT PK_vault_members PRIMARY KEY (vault_id, user_id),
                    CONSTRAINT FK_vault_members_vault    FOREIGN KEY (vault_id) REFERENCES vaults(id) ON DELETE CASCADE,
                    CONSTRAINT FK_vault_members_role     FOREIGN KEY (role)     REFERENCES ref_vault_roles(value) ON DELETE RESTRICT
                );
                INSERT INTO vault_members_new SELECT vault_id, user_id, role, joined_at FROM vault_members;
                DROP TABLE vault_members;
                ALTER TABLE vault_members_new RENAME TO vault_members;
                """);

            // - 4. Rebuild resource_permissions with FK → ref_resource_types,
            //       ref_permissions, ref_subject_types ------------─

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
                INSERT INTO resource_permissions_new SELECT id, resource_type, resource_id, subject_type, subject_id, permission, granted_by, granted_at, expires_at FROM resource_permissions;
                DROP TABLE resource_permissions;
                ALTER TABLE resource_permissions_new RENAME TO resource_permissions;
                CREATE UNIQUE INDEX IX_resource_permissions_unique ON resource_permissions (resource_type, resource_id, subject_type, subject_id);
                CREATE INDEX idx_rp_resource ON resource_permissions (resource_type, resource_id);
                """);

            // - 5. Rebuild share_links with FK → ref_resource_types, ref_permissions

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
                INSERT INTO share_links_new SELECT id, token, resource_type, resource_id, permission, created_by, created_at, expires_at, revoked_at FROM share_links;
                DROP TABLE share_links;
                ALTER TABLE share_links_new RENAME TO share_links;
                CREATE UNIQUE INDEX IX_share_links_token ON share_links (token);
                CREATE INDEX idx_sl_resource ON share_links (resource_type, resource_id);
                """);

            // - 6. Rebuild doc_links with FK → ref_link_types --------

            migrationBuilder.Sql("""
                CREATE TABLE doc_links_new (
                    id          TEXT NOT NULL,
                    source_id   TEXT NOT NULL,
                    vault_id    TEXT NOT NULL,
                    target_id   TEXT NULL,
                    target_path TEXT NOT NULL,
                    link_type   TEXT NOT NULL DEFAULT 'wikilink',
                    CONSTRAINT PK_doc_links PRIMARY KEY (id),
                    CONSTRAINT FK_doc_links_link_type FOREIGN KEY (link_type) REFERENCES ref_link_types(value) ON DELETE RESTRICT
                );
                INSERT INTO doc_links_new SELECT id, source_id, vault_id, target_id, target_path, link_type FROM doc_links;
                DROP TABLE doc_links;
                ALTER TABLE doc_links_new RENAME TO doc_links;
                CREATE INDEX idx_doc_links_source ON doc_links (source_id);
                CREATE INDEX idx_doc_links_target ON doc_links (target_id);
                CREATE INDEX idx_doc_links_target_path ON doc_links (vault_id, target_path);
                """);
        }

        protected override void Down(MigrationBuilder migrationBuilder)
        {
            // Restore tables without FK constraints (matching previous schema)
            migrationBuilder.Sql("""
                CREATE TABLE vault_members_old (vault_id TEXT NOT NULL, user_id TEXT NOT NULL, role TEXT NOT NULL, joined_at TEXT NOT NULL, CONSTRAINT PK_vault_members PRIMARY KEY (vault_id, user_id), CONSTRAINT FK_vault_members_vault FOREIGN KEY (vault_id) REFERENCES vaults(id) ON DELETE CASCADE);
                INSERT INTO vault_members_old SELECT vault_id, user_id, role, joined_at FROM vault_members;
                DROP TABLE vault_members;
                ALTER TABLE vault_members_old RENAME TO vault_members;
                """);

            migrationBuilder.Sql("""
                CREATE TABLE resource_permissions_old (id TEXT NOT NULL, resource_type TEXT NOT NULL, resource_id TEXT NOT NULL, subject_type TEXT NOT NULL, subject_id TEXT NOT NULL, permission TEXT NOT NULL, granted_by TEXT NOT NULL, granted_at TEXT NOT NULL, expires_at TEXT NULL, CONSTRAINT PK_resource_permissions PRIMARY KEY (id));
                INSERT INTO resource_permissions_old SELECT id, resource_type, resource_id, subject_type, subject_id, permission, granted_by, granted_at, expires_at FROM resource_permissions;
                DROP TABLE resource_permissions;
                ALTER TABLE resource_permissions_old RENAME TO resource_permissions;
                CREATE UNIQUE INDEX IX_resource_permissions_unique ON resource_permissions (resource_type, resource_id, subject_type, subject_id);
                CREATE INDEX idx_rp_resource ON resource_permissions (resource_type, resource_id);
                """);

            migrationBuilder.Sql("""
                CREATE TABLE share_links_old (id TEXT NOT NULL, token TEXT NOT NULL, resource_type TEXT NOT NULL, resource_id TEXT NOT NULL, permission TEXT NOT NULL, created_by TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NULL, revoked_at TEXT NULL, CONSTRAINT PK_share_links PRIMARY KEY (id));
                INSERT INTO share_links_old SELECT id, token, resource_type, resource_id, permission, created_by, created_at, expires_at, revoked_at FROM share_links;
                DROP TABLE share_links;
                ALTER TABLE share_links_old RENAME TO share_links;
                CREATE UNIQUE INDEX IX_share_links_token ON share_links (token);
                CREATE INDEX idx_sl_resource ON share_links (resource_type, resource_id);
                """);

            migrationBuilder.Sql("""
                CREATE TABLE doc_links_old (id TEXT NOT NULL, source_id TEXT NOT NULL, vault_id TEXT NOT NULL, target_id TEXT NULL, target_path TEXT NOT NULL, link_type TEXT NOT NULL DEFAULT 'wikilink', CONSTRAINT PK_doc_links PRIMARY KEY (id));
                INSERT INTO doc_links_old SELECT id, source_id, vault_id, target_id, target_path, link_type FROM doc_links;
                DROP TABLE doc_links;
                ALTER TABLE doc_links_old RENAME TO doc_links;
                CREATE INDEX idx_doc_links_source ON doc_links (source_id);
                CREATE INDEX idx_doc_links_target ON doc_links (target_id);
                CREATE INDEX idx_doc_links_target_path ON doc_links (vault_id, target_path);
                """);

            migrationBuilder.DropTable("ref_resource_types");
            migrationBuilder.DropTable("ref_permissions");
            migrationBuilder.DropTable("ref_vault_roles");
            migrationBuilder.DropTable("ref_link_types");
            migrationBuilder.DropTable("ref_subject_types");
            migrationBuilder.DropTable("ref_sync_change_types");
        }
    }
}
