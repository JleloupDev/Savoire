using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Savoire.Infrastructure.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class AddFeedbackReports : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "feedback_reports",
                columns: table => new
                {
                    id = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                    user_id = table.Column<string>(type: "text", nullable: false),
                    message = table.Column<string>(type: "text", nullable: false),
                    context = table.Column<string>(type: "text", nullable: false),
                    user_agent = table.Column<string>(type: "character varying(512)", maxLength: 512, nullable: true),
                    screenshot = table.Column<byte[]>(type: "bytea", nullable: true),
                    screenshot_type = table.Column<string>(type: "character varying(32)", maxLength: 32, nullable: true),
                    created_at = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    archived_at = table.Column<DateTime>(type: "timestamp with time zone", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_feedback_reports", x => x.id);
                });

            migrationBuilder.CreateIndex(
                name: "IX_feedback_reports_created_at",
                table: "feedback_reports",
                column: "created_at");

            migrationBuilder.CreateIndex(
                name: "IX_feedback_reports_user_id",
                table: "feedback_reports",
                column: "user_id");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "feedback_reports");
        }
    }
}
