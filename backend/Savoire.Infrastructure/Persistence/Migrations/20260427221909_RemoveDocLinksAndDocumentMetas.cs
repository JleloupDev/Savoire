using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

#pragma warning disable CA1814 // Prefer jagged arrays over multidimensional

namespace Savoire.Infrastructure.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class RemoveDocLinksAndDocumentMetas : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "doc_links");

            migrationBuilder.DropTable(
                name: "document_metas");

            migrationBuilder.DropTable(
                name: "ref_link_types");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "document_metas",
                columns: table => new
                {
                    document_id = table.Column<string>(type: "TEXT", nullable: false),
                    content_type = table.Column<string>(type: "TEXT", nullable: false, defaultValue: "text/markdown"),
                    derived_by = table.Column<string>(type: "TEXT", nullable: true),
                    derived_from = table.Column<string>(type: "TEXT", nullable: true),
                    frontmatter = table.Column<string>(type: "TEXT", nullable: false, defaultValue: "{}"),
                    indexed_at = table.Column<DateTime>(type: "TEXT", nullable: false),
                    tags = table.Column<string>(type: "TEXT", nullable: false, defaultValue: "[]"),
                    vault_id = table.Column<string>(type: "TEXT", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_document_metas", x => x.document_id);
                });

            migrationBuilder.CreateTable(
                name: "ref_link_types",
                columns: table => new
                {
                    value = table.Column<string>(type: "TEXT", nullable: false),
                    description = table.Column<string>(type: "TEXT", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_ref_link_types", x => x.value);
                });

            migrationBuilder.CreateTable(
                name: "doc_links",
                columns: table => new
                {
                    id = table.Column<string>(type: "TEXT", nullable: false),
                    source_id = table.Column<string>(type: "TEXT", nullable: false),
                    link_type = table.Column<string>(type: "TEXT", nullable: false, defaultValue: "wikilink"),
                    target_id = table.Column<string>(type: "TEXT", nullable: true),
                    target_path = table.Column<string>(type: "TEXT", nullable: false),
                    vault_id = table.Column<string>(type: "TEXT", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_doc_links", x => x.id);
                    table.ForeignKey(
                        name: "FK_doc_links_document_metas_source_id",
                        column: x => x.source_id,
                        principalTable: "document_metas",
                        principalColumn: "document_id",
                        onDelete: ReferentialAction.Cascade);
                    table.ForeignKey(
                        name: "FK_doc_links_ref_link_types_link_type",
                        column: x => x.link_type,
                        principalTable: "ref_link_types",
                        principalColumn: "value",
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.InsertData(
                table: "ref_link_types",
                columns: new[] { "value", "description" },
                values: new object[,]
                {
                    { "embed", "Embedded content: ![[path]]" },
                    { "wikilink", "Standard wikilink: [[path]]" }
                });

            migrationBuilder.CreateIndex(
                name: "idx_doc_links_source",
                table: "doc_links",
                column: "source_id");

            migrationBuilder.CreateIndex(
                name: "idx_doc_links_target",
                table: "doc_links",
                column: "target_id");

            migrationBuilder.CreateIndex(
                name: "idx_doc_links_target_path",
                table: "doc_links",
                columns: new[] { "vault_id", "target_path" });

            migrationBuilder.CreateIndex(
                name: "IX_doc_links_link_type",
                table: "doc_links",
                column: "link_type");

            migrationBuilder.CreateIndex(
                name: "idx_doc_metas_derived_from",
                table: "document_metas",
                column: "derived_from");

            migrationBuilder.CreateIndex(
                name: "idx_doc_metas_vault",
                table: "document_metas",
                column: "vault_id");
        }
    }
}
