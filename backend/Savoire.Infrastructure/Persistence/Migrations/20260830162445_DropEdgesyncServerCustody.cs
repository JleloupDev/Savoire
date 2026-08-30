using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Savoire.Infrastructure.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class DropEdgesyncServerCustody : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "managed_vault_keyrings");

            migrationBuilder.DropColumn(
                name: "is_managed",
                table: "vaults");

            migrationBuilder.DropColumn(
                name: "VaultKeyHex",
                table: "AspNetUsers");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<bool>(
                name: "is_managed",
                table: "vaults",
                type: "INTEGER",
                nullable: false,
                defaultValue: false);

            migrationBuilder.AddColumn<string>(
                name: "VaultKeyHex",
                table: "AspNetUsers",
                type: "TEXT",
                nullable: true);

            migrationBuilder.CreateTable(
                name: "managed_vault_keyrings",
                columns: table => new
                {
                    vault_id = table.Column<string>(type: "TEXT", nullable: false),
                    keyring_bytes = table.Column<byte[]>(type: "BLOB", nullable: false),
                    updated_at = table.Column<DateTime>(type: "TEXT", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_managed_vault_keyrings", x => x.vault_id);
                });
        }
    }
}
