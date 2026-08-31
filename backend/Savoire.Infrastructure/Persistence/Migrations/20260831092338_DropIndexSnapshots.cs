using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Savoire.Infrastructure.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class DropIndexSnapshots : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "index_snapshots");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "index_snapshots",
                columns: table => new
                {
                    id = table.Column<string>(type: "TEXT", nullable: false),
                    created_at = table.Column<DateTime>(type: "TEXT", nullable: false),
                    data = table.Column<string>(type: "TEXT", nullable: false),
                    @namespace = table.Column<string>(name: "namespace", type: "TEXT", nullable: false),
                    processed_seq = table.Column<long>(type: "INTEGER", nullable: false),
                    vault_id = table.Column<string>(type: "TEXT", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_index_snapshots", x => x.id);
                });

            migrationBuilder.CreateIndex(
                name: "idx_snapshots_vault_ns",
                table: "index_snapshots",
                columns: new[] { "vault_id", "namespace" });
        }
    }
}
