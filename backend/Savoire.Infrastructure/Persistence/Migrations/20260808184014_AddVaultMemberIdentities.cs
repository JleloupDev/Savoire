using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Savoire.Infrastructure.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class AddVaultMemberIdentities : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "vault_member_identities",
                columns: table => new
                {
                    vault_id = table.Column<string>(type: "TEXT", nullable: false),
                    sign_pub = table.Column<byte[]>(type: "BLOB", nullable: false),
                    user_id = table.Column<string>(type: "TEXT", nullable: false),
                    registered_at = table.Column<DateTime>(type: "TEXT", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_vault_member_identities", x => new { x.vault_id, x.sign_pub });
                });

            migrationBuilder.CreateIndex(
                name: "IX_vault_member_identities_vault_id_user_id",
                table: "vault_member_identities",
                columns: new[] { "vault_id", "user_id" });
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "vault_member_identities");
        }
    }
}
