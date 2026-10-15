using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Savoire.Infrastructure.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class AddVaultDocuments : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "vault_documents",
                columns: table => new
                {
                    doc_id = table.Column<string>(type: "TEXT", nullable: false),
                    vault_id = table.Column<string>(type: "TEXT", nullable: false),
                    registered_by = table.Column<string>(type: "TEXT", nullable: false),
                    registered_at = table.Column<DateTime>(type: "TEXT", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_vault_documents", x => x.doc_id);
                    table.ForeignKey(
                        name: "FK_vault_documents_vaults_vault_id",
                        column: x => x.vault_id,
                        principalTable: "vaults",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateIndex(
                name: "IX_vault_documents_vault_id",
                table: "vault_documents",
                column: "vault_id");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "vault_documents");
        }
    }
}
