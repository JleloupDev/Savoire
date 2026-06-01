// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Savoire.Infrastructure.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class AddResourceTypeToOps : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<string>(
                name: "resource_type",
                table: "operations_log",
                type: "TEXT",
                nullable: false,
                defaultValue: "document"); // backfill: existing rows are document ops

            migrationBuilder.DropIndex(
                name: "idx_ops_resource",
                table: "operations_log");

            migrationBuilder.CreateIndex(
                name: "idx_ops_resource",
                table: "operations_log",
                columns: new[] { "resource_type", "resource_id", "received_at" });
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropIndex(
                name: "idx_ops_resource",
                table: "operations_log");

            migrationBuilder.DropColumn(
                name: "resource_type",
                table: "operations_log");

            migrationBuilder.CreateIndex(
                name: "idx_ops_resource",
                table: "operations_log",
                columns: new[] { "resource_id", "received_at" });
        }
    }
}
