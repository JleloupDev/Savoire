// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
﻿using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Savoire.Infrastructure.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class AddMetadataIndex : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "doc_links",
                columns: table => new
                {
                    id = table.Column<string>(type: "TEXT", nullable: false),
                    source_id = table.Column<string>(type: "TEXT", nullable: false),
                    vault_id = table.Column<string>(type: "TEXT", nullable: false),
                    target_id = table.Column<string>(type: "TEXT", nullable: true),
                    target_path = table.Column<string>(type: "TEXT", nullable: false),
                    link_type = table.Column<string>(type: "TEXT", nullable: false, defaultValue: "wikilink")
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_doc_links", x => x.id);
                });

            migrationBuilder.CreateTable(
                name: "document_metas",
                columns: table => new
                {
                    document_id = table.Column<string>(type: "TEXT", nullable: false),
                    vault_id = table.Column<string>(type: "TEXT", nullable: false),
                    content_type = table.Column<string>(type: "TEXT", nullable: false, defaultValue: "text/markdown"),
                    derived_from = table.Column<string>(type: "TEXT", nullable: true),
                    derived_by = table.Column<string>(type: "TEXT", nullable: true),
                    tags = table.Column<string>(type: "TEXT", nullable: false, defaultValue: "[]"),
                    frontmatter = table.Column<string>(type: "TEXT", nullable: false, defaultValue: "{}"),
                    indexed_at = table.Column<DateTime>(type: "TEXT", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_document_metas", x => x.document_id);
                });

            migrationBuilder.CreateTable(
                name: "index_snapshots",
                columns: table => new
                {
                    id = table.Column<string>(type: "TEXT", nullable: false),
                    vault_id = table.Column<string>(type: "TEXT", nullable: false),
                    @namespace = table.Column<string>(name: "namespace", type: "TEXT", nullable: false),
                    processed_seq = table.Column<long>(type: "INTEGER", nullable: false),
                    data = table.Column<string>(type: "TEXT", nullable: false),
                    created_at = table.Column<DateTime>(type: "TEXT", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_index_snapshots", x => x.id);
                });

            migrationBuilder.CreateIndex(
                name: "idx_doc_links_source",
                table: "doc_links",
                column: "source_id");

            migrationBuilder.CreateIndex(
                name: "idx_doc_links_target",
                table: "doc_links",
                column: "target_id");

            migrationBuilder.CreateIndex(
                name: "idx_doc_links_target_path",
                table: "doc_links",
                columns: new[] { "vault_id", "target_path" });

            migrationBuilder.CreateIndex(
                name: "idx_doc_metas_derived_from",
                table: "document_metas",
                column: "derived_from");

            migrationBuilder.CreateIndex(
                name: "idx_doc_metas_vault",
                table: "document_metas",
                column: "vault_id");

            migrationBuilder.CreateIndex(
                name: "idx_snapshots_vault_ns",
                table: "index_snapshots",
                columns: new[] { "vault_id", "namespace" });
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "doc_links");

            migrationBuilder.DropTable(
                name: "document_metas");

            migrationBuilder.DropTable(
                name: "index_snapshots");
        }
    }
}
