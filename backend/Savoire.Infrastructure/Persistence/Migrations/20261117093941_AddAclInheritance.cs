using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Savoire.Infrastructure.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class AddAclInheritance : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<string>(
                name: "folder",
                table: "vault_documents",
                type: "character varying(1024)",
                maxLength: 1024,
                nullable: true);

            migrationBuilder.CreateTable(
                name: "acl_settings",
                columns: table => new
                {
                    resource_type = table.Column<string>(type: "character varying(16)", maxLength: 16, nullable: false),
                    resource_id = table.Column<string>(type: "character varying(1100)", maxLength: 1100, nullable: false),
                    vault_id = table.Column<string>(type: "text", nullable: false),
                    inherit = table.Column<bool>(type: "boolean", nullable: false),
                    updated_by = table.Column<string>(type: "text", nullable: false),
                    updated_at = table.Column<DateTime>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_acl_settings", x => new { x.resource_type, x.resource_id });
                    table.ForeignKey(
                        name: "FK_acl_settings_vaults_vault_id",
                        column: x => x.vault_id,
                        principalTable: "vaults",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.InsertData(
                table: "ref_permissions",
                columns: new[] { "value", "description" },
                values: new object[] { "none", "No access: overrides an inherited permission." });

            migrationBuilder.InsertData(
                table: "ref_resource_types",
                columns: new[] { "value", "description" },
                values: new object[] { "folder", "A folder of a vault: its content inherits its permissions." });

            migrationBuilder.CreateIndex(
                name: "IX_acl_settings_vault_id",
                table: "acl_settings",
                column: "vault_id");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "acl_settings");

            migrationBuilder.DeleteData(
                table: "ref_permissions",
                keyColumn: "value",
                keyValue: "none");

            migrationBuilder.DeleteData(
                table: "ref_resource_types",
                keyColumn: "value",
                keyValue: "folder");

            migrationBuilder.DropColumn(
                name: "folder",
                table: "vault_documents");
        }
    }
}
