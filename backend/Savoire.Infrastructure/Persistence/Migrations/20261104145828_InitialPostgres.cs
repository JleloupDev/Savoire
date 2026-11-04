using System;
using Microsoft.EntityFrameworkCore.Migrations;
using Npgsql.EntityFrameworkCore.PostgreSQL.Metadata;

#nullable disable

#pragma warning disable CA1814 // Prefer jagged arrays over multidimensional

namespace Savoire.Infrastructure.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class InitialPostgres : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "AspNetRoles",
                columns: table => new
                {
                    Id = table.Column<string>(type: "text", nullable: false),
                    Name = table.Column<string>(type: "character varying(256)", maxLength: 256, nullable: true),
                    NormalizedName = table.Column<string>(type: "character varying(256)", maxLength: 256, nullable: true),
                    ConcurrencyStamp = table.Column<string>(type: "text", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_AspNetRoles", x => x.Id);
                });

            migrationBuilder.CreateTable(
                name: "AspNetUsers",
                columns: table => new
                {
                    Id = table.Column<string>(type: "text", nullable: false),
                    DisplayName = table.Column<string>(type: "text", nullable: false),
                    CreatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    LastLoginAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    IsAdmin = table.Column<bool>(type: "boolean", nullable: false),
                    PrivateKeyHex = table.Column<string>(type: "text", nullable: true),
                    UserName = table.Column<string>(type: "character varying(256)", maxLength: 256, nullable: true),
                    NormalizedUserName = table.Column<string>(type: "character varying(256)", maxLength: 256, nullable: true),
                    Email = table.Column<string>(type: "character varying(256)", maxLength: 256, nullable: true),
                    NormalizedEmail = table.Column<string>(type: "character varying(256)", maxLength: 256, nullable: true),
                    EmailConfirmed = table.Column<bool>(type: "boolean", nullable: false),
                    PasswordHash = table.Column<string>(type: "text", nullable: true),
                    SecurityStamp = table.Column<string>(type: "text", nullable: true),
                    ConcurrencyStamp = table.Column<string>(type: "text", nullable: true),
                    PhoneNumber = table.Column<string>(type: "text", nullable: true),
                    PhoneNumberConfirmed = table.Column<bool>(type: "boolean", nullable: false),
                    TwoFactorEnabled = table.Column<bool>(type: "boolean", nullable: false),
                    LockoutEnd = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    LockoutEnabled = table.Column<bool>(type: "boolean", nullable: false),
                    AccessFailedCount = table.Column<int>(type: "integer", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_AspNetUsers", x => x.Id);
                });

            migrationBuilder.CreateTable(
                name: "edgesync_blobs",
                columns: table => new
                {
                    vault_id = table.Column<string>(type: "text", nullable: false),
                    key = table.Column<string>(type: "text", nullable: false),
                    bytes = table.Column<byte[]>(type: "bytea", nullable: false),
                    updated_at = table.Column<DateTime>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_edgesync_blobs", x => new { x.vault_id, x.key });
                });

            migrationBuilder.CreateTable(
                name: "indexer_changes",
                columns: table => new
                {
                    seq = table.Column<long>(type: "bigint", nullable: false)
                        .Annotation("Npgsql:ValueGenerationStrategy", NpgsqlValueGenerationStrategy.IdentityByDefaultColumn),
                    resource_key = table.Column<string>(type: "text", nullable: false),
                    vault_id = table.Column<string>(type: "text", nullable: false),
                    kind = table.Column<string>(type: "text", nullable: false),
                    doc_id = table.Column<string>(type: "text", nullable: true),
                    changed_at = table.Column<DateTime>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_indexer_changes", x => x.seq);
                });

            migrationBuilder.CreateTable(
                name: "indexer_feed_state",
                columns: table => new
                {
                    key = table.Column<string>(type: "text", nullable: false),
                    value = table.Column<string>(type: "text", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_indexer_feed_state", x => x.key);
                });

            migrationBuilder.CreateTable(
                name: "operations_log",
                columns: table => new
                {
                    id = table.Column<string>(type: "text", nullable: false),
                    resource_type = table.Column<string>(type: "text", nullable: false),
                    resource_id = table.Column<string>(type: "text", nullable: false),
                    client_id = table.Column<string>(type: "text", nullable: false),
                    produced_at = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    received_at = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    op_bytes = table.Column<byte[]>(type: "bytea", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_operations_log", x => x.id);
                });

            migrationBuilder.CreateTable(
                name: "ref_permissions",
                columns: table => new
                {
                    value = table.Column<string>(type: "text", nullable: false),
                    description = table.Column<string>(type: "text", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_ref_permissions", x => x.value);
                });

            migrationBuilder.CreateTable(
                name: "ref_resource_types",
                columns: table => new
                {
                    value = table.Column<string>(type: "text", nullable: false),
                    description = table.Column<string>(type: "text", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_ref_resource_types", x => x.value);
                });

            migrationBuilder.CreateTable(
                name: "ref_subject_types",
                columns: table => new
                {
                    value = table.Column<string>(type: "text", nullable: false),
                    description = table.Column<string>(type: "text", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_ref_subject_types", x => x.value);
                });

            migrationBuilder.CreateTable(
                name: "ref_sync_change_types",
                columns: table => new
                {
                    value = table.Column<string>(type: "text", nullable: false),
                    description = table.Column<string>(type: "text", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_ref_sync_change_types", x => x.value);
                });

            migrationBuilder.CreateTable(
                name: "ref_vault_roles",
                columns: table => new
                {
                    value = table.Column<string>(type: "text", nullable: false),
                    description = table.Column<string>(type: "text", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_ref_vault_roles", x => x.value);
                });

            migrationBuilder.CreateTable(
                name: "RefreshTokens",
                columns: table => new
                {
                    Id = table.Column<string>(type: "text", nullable: false),
                    UserId = table.Column<string>(type: "text", nullable: false),
                    Token = table.Column<string>(type: "text", nullable: false),
                    CreatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    ExpiresAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    RevokedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    ReplacedByToken = table.Column<string>(type: "text", nullable: true),
                    ClientIp = table.Column<string>(type: "text", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_RefreshTokens", x => x.Id);
                });

            migrationBuilder.CreateTable(
                name: "sync_vectors",
                columns: table => new
                {
                    resource_id = table.Column<string>(type: "text", nullable: false),
                    client_id = table.Column<string>(type: "text", nullable: false),
                    vector = table.Column<byte[]>(type: "bytea", nullable: false),
                    updated_at = table.Column<DateTime>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_sync_vectors", x => new { x.resource_id, x.client_id });
                });

            migrationBuilder.CreateTable(
                name: "vault_key_wraps",
                columns: table => new
                {
                    user_id = table.Column<string>(type: "text", nullable: false),
                    vault_id = table.Column<string>(type: "text", nullable: false),
                    wrapped_key_bytes = table.Column<byte[]>(type: "bytea", nullable: false),
                    updated_at = table.Column<DateTime>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_vault_key_wraps", x => new { x.user_id, x.vault_id });
                });

            migrationBuilder.CreateTable(
                name: "vault_member_identities",
                columns: table => new
                {
                    vault_id = table.Column<string>(type: "text", nullable: false),
                    sign_pub = table.Column<byte[]>(type: "bytea", nullable: false),
                    user_id = table.Column<string>(type: "text", nullable: false),
                    registered_at = table.Column<DateTime>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_vault_member_identities", x => new { x.vault_id, x.sign_pub });
                });

            migrationBuilder.CreateTable(
                name: "vaults",
                columns: table => new
                {
                    id = table.Column<string>(type: "text", nullable: false),
                    name = table.Column<string>(type: "text", nullable: false),
                    owner_id = table.Column<string>(type: "text", nullable: false),
                    created_at = table.Column<DateTime>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_vaults", x => x.id);
                });

            migrationBuilder.CreateTable(
                name: "AspNetRoleClaims",
                columns: table => new
                {
                    Id = table.Column<int>(type: "integer", nullable: false)
                        .Annotation("Npgsql:ValueGenerationStrategy", NpgsqlValueGenerationStrategy.IdentityByDefaultColumn),
                    RoleId = table.Column<string>(type: "text", nullable: false),
                    ClaimType = table.Column<string>(type: "text", nullable: true),
                    ClaimValue = table.Column<string>(type: "text", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_AspNetRoleClaims", x => x.Id);
                    table.ForeignKey(
                        name: "FK_AspNetRoleClaims_AspNetRoles_RoleId",
                        column: x => x.RoleId,
                        principalTable: "AspNetRoles",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "AspNetUserClaims",
                columns: table => new
                {
                    Id = table.Column<int>(type: "integer", nullable: false)
                        .Annotation("Npgsql:ValueGenerationStrategy", NpgsqlValueGenerationStrategy.IdentityByDefaultColumn),
                    UserId = table.Column<string>(type: "text", nullable: false),
                    ClaimType = table.Column<string>(type: "text", nullable: true),
                    ClaimValue = table.Column<string>(type: "text", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_AspNetUserClaims", x => x.Id);
                    table.ForeignKey(
                        name: "FK_AspNetUserClaims_AspNetUsers_UserId",
                        column: x => x.UserId,
                        principalTable: "AspNetUsers",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "AspNetUserLogins",
                columns: table => new
                {
                    LoginProvider = table.Column<string>(type: "text", nullable: false),
                    ProviderKey = table.Column<string>(type: "text", nullable: false),
                    ProviderDisplayName = table.Column<string>(type: "text", nullable: true),
                    UserId = table.Column<string>(type: "text", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_AspNetUserLogins", x => new { x.LoginProvider, x.ProviderKey });
                    table.ForeignKey(
                        name: "FK_AspNetUserLogins_AspNetUsers_UserId",
                        column: x => x.UserId,
                        principalTable: "AspNetUsers",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "AspNetUserRoles",
                columns: table => new
                {
                    UserId = table.Column<string>(type: "text", nullable: false),
                    RoleId = table.Column<string>(type: "text", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_AspNetUserRoles", x => new { x.UserId, x.RoleId });
                    table.ForeignKey(
                        name: "FK_AspNetUserRoles_AspNetRoles_RoleId",
                        column: x => x.RoleId,
                        principalTable: "AspNetRoles",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                    table.ForeignKey(
                        name: "FK_AspNetUserRoles_AspNetUsers_UserId",
                        column: x => x.UserId,
                        principalTable: "AspNetUsers",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "AspNetUserTokens",
                columns: table => new
                {
                    UserId = table.Column<string>(type: "text", nullable: false),
                    LoginProvider = table.Column<string>(type: "text", nullable: false),
                    Name = table.Column<string>(type: "text", nullable: false),
                    Value = table.Column<string>(type: "text", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_AspNetUserTokens", x => new { x.UserId, x.LoginProvider, x.Name });
                    table.ForeignKey(
                        name: "FK_AspNetUserTokens_AspNetUsers_UserId",
                        column: x => x.UserId,
                        principalTable: "AspNetUsers",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "share_links",
                columns: table => new
                {
                    id = table.Column<string>(type: "text", nullable: false),
                    token = table.Column<string>(type: "text", nullable: false),
                    resource_type = table.Column<string>(type: "text", nullable: false),
                    resource_id = table.Column<string>(type: "text", nullable: false),
                    permission = table.Column<string>(type: "text", nullable: false),
                    created_by = table.Column<string>(type: "text", nullable: false),
                    created_at = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    expires_at = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    revoked_at = table.Column<DateTime>(type: "timestamp with time zone", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_share_links", x => x.id);
                    table.ForeignKey(
                        name: "FK_share_links_ref_permissions_permission",
                        column: x => x.permission,
                        principalTable: "ref_permissions",
                        principalColumn: "value",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "FK_share_links_ref_resource_types_resource_type",
                        column: x => x.resource_type,
                        principalTable: "ref_resource_types",
                        principalColumn: "value",
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateTable(
                name: "resource_permissions",
                columns: table => new
                {
                    id = table.Column<string>(type: "text", nullable: false),
                    resource_type = table.Column<string>(type: "text", nullable: false),
                    resource_id = table.Column<string>(type: "text", nullable: false),
                    subject_type = table.Column<string>(type: "text", nullable: false),
                    subject_id = table.Column<string>(type: "text", nullable: false),
                    permission = table.Column<string>(type: "text", nullable: false),
                    granted_by = table.Column<string>(type: "text", nullable: false),
                    granted_at = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    expires_at = table.Column<DateTime>(type: "timestamp with time zone", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_resource_permissions", x => x.id);
                    table.ForeignKey(
                        name: "FK_resource_permissions_ref_permissions_permission",
                        column: x => x.permission,
                        principalTable: "ref_permissions",
                        principalColumn: "value",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "FK_resource_permissions_ref_resource_types_resource_type",
                        column: x => x.resource_type,
                        principalTable: "ref_resource_types",
                        principalColumn: "value",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "FK_resource_permissions_ref_subject_types_subject_type",
                        column: x => x.subject_type,
                        principalTable: "ref_subject_types",
                        principalColumn: "value",
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateTable(
                name: "folders",
                columns: table => new
                {
                    id = table.Column<string>(type: "text", nullable: false),
                    vault_id = table.Column<string>(type: "text", nullable: false),
                    path = table.Column<string>(type: "text", nullable: false),
                    created_at = table.Column<DateTime>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_folders", x => x.id);
                    table.ForeignKey(
                        name: "FK_folders_vaults_vault_id",
                        column: x => x.vault_id,
                        principalTable: "vaults",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "vault_documents",
                columns: table => new
                {
                    doc_id = table.Column<string>(type: "text", nullable: false),
                    vault_id = table.Column<string>(type: "text", nullable: false),
                    registered_by = table.Column<string>(type: "text", nullable: false),
                    registered_at = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    parent_doc_id = table.Column<string>(type: "text", nullable: true),
                    name = table.Column<string>(type: "text", nullable: true)
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

            migrationBuilder.CreateTable(
                name: "vault_indexer_settings",
                columns: table => new
                {
                    vault_id = table.Column<string>(type: "text", nullable: false),
                    mode = table.Column<string>(type: "text", nullable: false),
                    url = table.Column<string>(type: "text", nullable: true),
                    updated_by = table.Column<string>(type: "text", nullable: false),
                    updated_at = table.Column<DateTime>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_vault_indexer_settings", x => x.vault_id);
                    table.ForeignKey(
                        name: "FK_vault_indexer_settings_vaults_vault_id",
                        column: x => x.vault_id,
                        principalTable: "vaults",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "vault_members",
                columns: table => new
                {
                    vault_id = table.Column<string>(type: "text", nullable: false),
                    user_id = table.Column<string>(type: "text", nullable: false),
                    role = table.Column<string>(type: "text", nullable: false),
                    joined_at = table.Column<DateTime>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_vault_members", x => new { x.vault_id, x.user_id });
                    table.ForeignKey(
                        name: "FK_vault_members_ref_vault_roles_role",
                        column: x => x.role,
                        principalTable: "ref_vault_roles",
                        principalColumn: "value",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "FK_vault_members_vaults_vault_id",
                        column: x => x.vault_id,
                        principalTable: "vaults",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.InsertData(
                table: "ref_permissions",
                columns: new[] { "value", "description" },
                values: new object[,]
                {
                    { "admin", "Full control, including sharing the resource." },
                    { "read", "Read-only access to the resource." },
                    { "write", "Read and write access to the resource." }
                });

            migrationBuilder.InsertData(
                table: "ref_resource_types",
                columns: new[] { "value", "description" },
                values: new object[,]
                {
                    { "document", "A single document within a vault." },
                    { "vault", "A vault — contains documents and folders." }
                });

            migrationBuilder.InsertData(
                table: "ref_subject_types",
                columns: new[] { "value", "description" },
                values: new object[] { "user", "An individual user account." });

            migrationBuilder.InsertData(
                table: "ref_sync_change_types",
                columns: new[] { "value", "description" },
                values: new object[,]
                {
                    { "created", "Document was created after the sync baseline." },
                    { "deleted", "Document was soft-deleted after the sync baseline." },
                    { "modified", "Document was modified after the sync baseline." },
                    { "moved", "Document was moved (reserved — not yet produced by the server)." }
                });

            migrationBuilder.InsertData(
                table: "ref_vault_roles",
                columns: new[] { "value", "description" },
                values: new object[,]
                {
                    { "editor", "Can read and write documents." },
                    { "owner", "Vault creator — cannot be removed, has all permissions." },
                    { "viewer", "Read-only access to all documents in the vault." }
                });

            migrationBuilder.CreateIndex(
                name: "IX_AspNetRoleClaims_RoleId",
                table: "AspNetRoleClaims",
                column: "RoleId");

            migrationBuilder.CreateIndex(
                name: "RoleNameIndex",
                table: "AspNetRoles",
                column: "NormalizedName",
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_AspNetUserClaims_UserId",
                table: "AspNetUserClaims",
                column: "UserId");

            migrationBuilder.CreateIndex(
                name: "IX_AspNetUserLogins_UserId",
                table: "AspNetUserLogins",
                column: "UserId");

            migrationBuilder.CreateIndex(
                name: "IX_AspNetUserRoles_RoleId",
                table: "AspNetUserRoles",
                column: "RoleId");

            migrationBuilder.CreateIndex(
                name: "EmailIndex",
                table: "AspNetUsers",
                column: "NormalizedEmail");

            migrationBuilder.CreateIndex(
                name: "UserNameIndex",
                table: "AspNetUsers",
                column: "NormalizedUserName",
                unique: true);

            migrationBuilder.CreateIndex(
                name: "idx_folders_vault",
                table: "folders",
                column: "vault_id");

            migrationBuilder.CreateIndex(
                name: "IX_folders_vault_id_path",
                table: "folders",
                columns: new[] { "vault_id", "path" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_indexer_changes_resource_key",
                table: "indexer_changes",
                column: "resource_key",
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_indexer_changes_vault_id",
                table: "indexer_changes",
                column: "vault_id");

            migrationBuilder.CreateIndex(
                name: "idx_ops_resource",
                table: "operations_log",
                columns: new[] { "resource_type", "resource_id", "received_at" });

            migrationBuilder.CreateIndex(
                name: "IX_RefreshTokens_Token",
                table: "RefreshTokens",
                column: "Token",
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_RefreshTokens_UserId",
                table: "RefreshTokens",
                column: "UserId");

            migrationBuilder.CreateIndex(
                name: "idx_rp_resource",
                table: "resource_permissions",
                columns: new[] { "resource_type", "resource_id" });

            migrationBuilder.CreateIndex(
                name: "IX_resource_permissions_permission",
                table: "resource_permissions",
                column: "permission");

            migrationBuilder.CreateIndex(
                name: "IX_resource_permissions_subject_type",
                table: "resource_permissions",
                column: "subject_type");

            migrationBuilder.CreateIndex(
                name: "IX_resource_permissions_unique",
                table: "resource_permissions",
                columns: new[] { "resource_type", "resource_id", "subject_type", "subject_id" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "idx_sl_resource",
                table: "share_links",
                columns: new[] { "resource_type", "resource_id" });

            migrationBuilder.CreateIndex(
                name: "IX_share_links_permission",
                table: "share_links",
                column: "permission");

            migrationBuilder.CreateIndex(
                name: "IX_share_links_token",
                table: "share_links",
                column: "token",
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_vault_documents_parent_doc_id",
                table: "vault_documents",
                column: "parent_doc_id");

            migrationBuilder.CreateIndex(
                name: "IX_vault_documents_vault_id",
                table: "vault_documents",
                column: "vault_id");

            migrationBuilder.CreateIndex(
                name: "IX_vault_member_identities_vault_id_user_id",
                table: "vault_member_identities",
                columns: new[] { "vault_id", "user_id" });

            migrationBuilder.CreateIndex(
                name: "IX_vault_members_role",
                table: "vault_members",
                column: "role");

            // Epoque du flux du pair indexeur (docs/Architecture/indexer-protocol.md).
            migrationBuilder.Sql(
                "INSERT INTO indexer_feed_state (key, value) VALUES ('epoch', replace(gen_random_uuid()::text, '-', ''));");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "AspNetRoleClaims");

            migrationBuilder.DropTable(
                name: "AspNetUserClaims");

            migrationBuilder.DropTable(
                name: "AspNetUserLogins");

            migrationBuilder.DropTable(
                name: "AspNetUserRoles");

            migrationBuilder.DropTable(
                name: "AspNetUserTokens");

            migrationBuilder.DropTable(
                name: "edgesync_blobs");

            migrationBuilder.DropTable(
                name: "folders");

            migrationBuilder.DropTable(
                name: "indexer_changes");

            migrationBuilder.DropTable(
                name: "indexer_feed_state");

            migrationBuilder.DropTable(
                name: "operations_log");

            migrationBuilder.DropTable(
                name: "ref_sync_change_types");

            migrationBuilder.DropTable(
                name: "RefreshTokens");

            migrationBuilder.DropTable(
                name: "resource_permissions");

            migrationBuilder.DropTable(
                name: "share_links");

            migrationBuilder.DropTable(
                name: "sync_vectors");

            migrationBuilder.DropTable(
                name: "vault_documents");

            migrationBuilder.DropTable(
                name: "vault_indexer_settings");

            migrationBuilder.DropTable(
                name: "vault_key_wraps");

            migrationBuilder.DropTable(
                name: "vault_member_identities");

            migrationBuilder.DropTable(
                name: "vault_members");

            migrationBuilder.DropTable(
                name: "AspNetRoles");

            migrationBuilder.DropTable(
                name: "AspNetUsers");

            migrationBuilder.DropTable(
                name: "ref_subject_types");

            migrationBuilder.DropTable(
                name: "ref_permissions");

            migrationBuilder.DropTable(
                name: "ref_resource_types");

            migrationBuilder.DropTable(
                name: "ref_vault_roles");

            migrationBuilder.DropTable(
                name: "vaults");
        }
    }
}
