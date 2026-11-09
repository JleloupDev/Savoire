using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Savoire.Infrastructure.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class AddPublications : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "publications",
                columns: table => new
                {
                    slug = table.Column<string>(type: "character varying(120)", maxLength: 120, nullable: false),
                    vault_id = table.Column<string>(type: "text", nullable: false),
                    document_id = table.Column<string>(type: "text", nullable: false),
                    title = table.Column<string>(type: "text", nullable: false),
                    description = table.Column<string>(type: "text", nullable: false),
                    html = table.Column<string>(type: "text", nullable: false),
                    indexable = table.Column<bool>(type: "boolean", nullable: false),
                    created_by = table.Column<string>(type: "text", nullable: false),
                    created_at = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    updated_at = table.Column<DateTime>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_publications", x => x.slug);
                });

            migrationBuilder.CreateIndex(
                name: "IX_publications_document_id",
                table: "publications",
                column: "document_id",
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_publications_vault_id",
                table: "publications",
                column: "vault_id");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "publications");
        }
    }
}
