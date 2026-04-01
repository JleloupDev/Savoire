// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
﻿using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Savoire.Infrastructure.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class AddSharing : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "resource_permissions",
                columns: table => new
                {
                    id = table.Column<string>(type: "TEXT", nullable: false),
                    resource_type = table.Column<string>(type: "TEXT", nullable: false),
                    resource_id = table.Column<string>(type: "TEXT", nullable: false),
                    subject_type = table.Column<string>(type: "TEXT", nullable: false),
                    subject_id = table.Column<string>(type: "TEXT", nullable: false),
                    permission = table.Column<string>(type: "TEXT", nullable: false),
                    granted_by = table.Column<string>(type: "TEXT", nullable: false),
                    granted_at = table.Column<DateTime>(type: "TEXT", nullable: false),
                    expires_at = table.Column<DateTime>(type: "TEXT", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_resource_permissions", x => x.id);
                });

            migrationBuilder.CreateTable(
                name: "share_links",
                columns: table => new
                {
                    id = table.Column<string>(type: "TEXT", nullable: false),
                    token = table.Column<string>(type: "TEXT", nullable: false),
                    resource_type = table.Column<string>(type: "TEXT", nullable: false),
                    resource_id = table.Column<string>(type: "TEXT", nullable: false),
                    permission = table.Column<string>(type: "TEXT", nullable: false),
                    created_by = table.Column<string>(type: "TEXT", nullable: false),
                    created_at = table.Column<DateTime>(type: "TEXT", nullable: false),
                    expires_at = table.Column<DateTime>(type: "TEXT", nullable: true),
                    revoked_at = table.Column<DateTime>(type: "TEXT", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_share_links", x => x.id);
                });

            migrationBuilder.CreateIndex(
                name: "idx_rp_resource",
                table: "resource_permissions",
                columns: new[] { "resource_type", "resource_id" });

            migrationBuilder.CreateIndex(
                name: "IX_resource_permissions_unique",
                table: "resource_permissions",
                columns: new[] { "resource_type", "resource_id", "subject_type", "subject_id" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "idx_sl_resource",
                table: "share_links",
                columns: new[] { "resource_type", "resource_id" });

            migrationBuilder.CreateIndex(
                name: "IX_share_links_token",
                table: "share_links",
                column: "token",
                unique: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "resource_permissions");

            migrationBuilder.DropTable(
                name: "share_links");
        }
    }
}
