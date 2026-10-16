using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Savoire.Infrastructure.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class AddAttachmentPlacement : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<string>(
                name: "name",
                table: "vault_documents",
                type: "TEXT",
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "parent_doc_id",
                table: "vault_documents",
                type: "TEXT",
                nullable: true);

            migrationBuilder.CreateIndex(
                name: "IX_vault_documents_parent_doc_id",
                table: "vault_documents",
                column: "parent_doc_id");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropIndex(
                name: "IX_vault_documents_parent_doc_id",
                table: "vault_documents");

            migrationBuilder.DropColumn(
                name: "name",
                table: "vault_documents");

            migrationBuilder.DropColumn(
                name: "parent_doc_id",
                table: "vault_documents");
        }
    }
}
