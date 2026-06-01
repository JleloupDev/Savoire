// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Savoire.Infrastructure.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class UnifyCrdtOpLog : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            // Rename document_id -> resource_id in operations_log
            migrationBuilder.RenameColumn(
                name: "document_id",
                table: "operations_log",
                newName: "resource_id");

            migrationBuilder.RenameIndex(
                name: "idx_ops_document",
                table: "operations_log",
                newName: "idx_ops_resource");

            // Rename document_id -> resource_id in sync_vectors
            migrationBuilder.RenameColumn(
                name: "document_id",
                table: "sync_vectors",
                newName: "resource_id");

            // Drop vault_operations_log if it was created by a previous migration
            migrationBuilder.Sql(
                "DROP TABLE IF EXISTS vault_operations_log;");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.RenameColumn(
                name: "resource_id",
                table: "operations_log",
                newName: "document_id");

            migrationBuilder.RenameIndex(
                name: "idx_ops_resource",
                table: "operations_log",
                newName: "idx_ops_document");

            migrationBuilder.RenameColumn(
                name: "resource_id",
                table: "sync_vectors",
                newName: "document_id");
        }
    }
}
