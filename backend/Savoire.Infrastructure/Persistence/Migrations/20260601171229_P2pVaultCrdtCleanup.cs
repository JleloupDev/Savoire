using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Savoire.Infrastructure.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class P2pVaultCrdtCleanup : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "documents");

            migrationBuilder.DropIndex(
                name: "idx_ops_document",
                table: "operations_log");

            migrationBuilder.RenameColumn(
                name: "document_id",
                table: "sync_vectors",
                newName: "resource_id");

            // operations_log: rename document_id -> resource_id, add resource_type.
            // Existing rows are document CRDT ops, so backfill resource_type = "document".
            migrationBuilder.RenameColumn(
                name: "document_id",
                table: "operations_log",
                newName: "resource_id");

            migrationBuilder.AddColumn<string>(
                name: "resource_type",
                table: "operations_log",
                type: "TEXT",
                nullable: false,
                defaultValue: "document");

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

            migrationBuilder.RenameColumn(
                name: "resource_id",
                table: "sync_vectors",
                newName: "document_id");

            migrationBuilder.RenameColumn(
                name: "resource_id",
                table: "operations_log",
                newName: "document_id");

            migrationBuilder.CreateTable(
                name: "documents",
                columns: table => new
                {
                    id = table.Column<string>(type: "TEXT", nullable: false),
                    vault_id = table.Column<string>(type: "TEXT", nullable: false),
                    created_at = table.Column<DateTime>(type: "TEXT", nullable: false),
                    deleted_at = table.Column<DateTime>(type: "TEXT", nullable: true),
                    hash = table.Column<string>(type: "TEXT", nullable: false, defaultValue: ""),
                    path = table.Column<string>(type: "TEXT", nullable: false),
                    size_bytes = table.Column<long>(type: "INTEGER", nullable: false, defaultValue: 0L),
                    title = table.Column<string>(type: "TEXT", nullable: true),
                    updated_at = table.Column<DateTime>(type: "TEXT", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_documents", x => x.id);
                    table.ForeignKey(
                        name: "FK_documents_vaults_vault_id",
                        column: x => x.vault_id,
                        principalTable: "vaults",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateIndex(
                name: "idx_ops_document",
                table: "operations_log",
                columns: new[] { "document_id", "received_at" });

            migrationBuilder.CreateIndex(
                name: "idx_documents_vault",
                table: "documents",
                columns: new[] { "vault_id", "deleted_at" });

            migrationBuilder.CreateIndex(
                name: "IX_documents_vault_id_path",
                table: "documents",
                columns: new[] { "vault_id", "path" },
                unique: true);
        }
    }
}
