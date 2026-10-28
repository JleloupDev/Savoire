// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// Pair indexeur (ADR-027) : flux de changements, etat du flux, reglage du vault.
using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Savoire.Infrastructure.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class AddIndexerFeed : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "indexer_changes",
                columns: table => new
                {
                    seq = table.Column<long>(type: "INTEGER", nullable: false)
                        .Annotation("Sqlite:Autoincrement", true),
                    resource_key = table.Column<string>(type: "TEXT", nullable: false),
                    vault_id = table.Column<string>(type: "TEXT", nullable: false),
                    kind = table.Column<string>(type: "TEXT", nullable: false),
                    doc_id = table.Column<string>(type: "TEXT", nullable: true),
                    changed_at = table.Column<DateTime>(type: "TEXT", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_indexer_changes", x => x.seq);
                });

            migrationBuilder.CreateTable(
                name: "indexer_feed_state",
                columns: table => new
                {
                    key = table.Column<string>(type: "TEXT", nullable: false),
                    value = table.Column<string>(type: "TEXT", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_indexer_feed_state", x => x.key);
                });

            migrationBuilder.CreateTable(
                name: "vault_indexer_settings",
                columns: table => new
                {
                    vault_id = table.Column<string>(type: "TEXT", nullable: false),
                    mode = table.Column<string>(type: "TEXT", nullable: false),
                    url = table.Column<string>(type: "TEXT", nullable: true),
                    updated_by = table.Column<string>(type: "TEXT", nullable: false),
                    updated_at = table.Column<DateTime>(type: "TEXT", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_vault_indexer_settings", x => x.vault_id);
                    table.ForeignKey(
                        name: "FK_vault_indexer_settings_vaults_vault_id",
                        column: x => x.vault_id,
                        principalTable: "vaults",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateIndex(
                name: "IX_indexer_changes_resource_key",
                table: "indexer_changes",
                column: "resource_key",
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_indexer_changes_vault_id",
                table: "indexer_changes",
                column: "vault_id");

            // Identifiant de cette base : une base recreee en recoit un autre,
            // et le pair indexeur sait qu'il doit tout reconstruire.
            migrationBuilder.Sql(
                "INSERT INTO indexer_feed_state (key, value) VALUES ('epoch', lower(hex(randomblob(16))));");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "indexer_changes");

            migrationBuilder.DropTable(
                name: "indexer_feed_state");

            migrationBuilder.DropTable(
                name: "vault_indexer_settings");
        }
    }
}
