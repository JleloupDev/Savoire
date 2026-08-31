// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// AppDbContext — DECISION: migrated to IdentityDbContext<AppUser> for V1 auth.
// Switched from EnsureCreated() to MigrateAsync() to support EF migrations.

using Microsoft.AspNetCore.Identity.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore;
using Savoire.Domain.Entities;

namespace Savoire.Infrastructure.Persistence;

public class AppDbContext(DbContextOptions<AppDbContext> options)
    : IdentityDbContext<AppUser>(options)
{
    public DbSet<RefResourceTypeEntity>   RefResourceTypes   => Set<RefResourceTypeEntity>();
    public DbSet<RefPermissionEntity>     RefPermissions     => Set<RefPermissionEntity>();
    public DbSet<RefVaultRoleEntity>      RefVaultRoles      => Set<RefVaultRoleEntity>();
    public DbSet<RefSubjectTypeEntity>    RefSubjectTypes    => Set<RefSubjectTypeEntity>();
    public DbSet<RefSyncChangeTypeEntity> RefSyncChangeTypes => Set<RefSyncChangeTypeEntity>();
    public DbSet<VaultEntity>             Vaults             => Set<VaultEntity>();
    public DbSet<VaultMemberEntity> VaultMembers => Set<VaultMemberEntity>();
    public DbSet<FolderEntity>      Folders     => Set<FolderEntity>();
    public DbSet<OperationEntity>  Operations  => Set<OperationEntity>();
    public DbSet<SyncVectorEntity> SyncVectors => Set<SyncVectorEntity>();
    public DbSet<RefreshToken>              RefreshTokens       => Set<RefreshToken>();
    public DbSet<ResourcePermissionEntity>  ResourcePermissions => Set<ResourcePermissionEntity>();
    public DbSet<ShareLinkEntity>           ShareLinks          => Set<ShareLinkEntity>();
    public DbSet<EdgesyncBlobEntity>        EdgesyncBlobs       => Set<EdgesyncBlobEntity>();
    public DbSet<VaultKeyWrapEntity>        VaultKeyWraps       => Set<VaultKeyWrapEntity>();
    public DbSet<VaultMemberIdentityEntity> VaultMemberIdentities => Set<VaultMemberIdentityEntity>();

    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        base.OnModelCreating(modelBuilder);  // REQUIRED for Identity

        // ── Reference tables ──────────────────────────────────────────────────
        ConfigureRefTable<RefResourceTypeEntity>(modelBuilder, "ref_resource_types");
        ConfigureRefTable<RefPermissionEntity>  (modelBuilder, "ref_permissions");
        ConfigureRefTable<RefVaultRoleEntity>   (modelBuilder, "ref_vault_roles");
        ConfigureRefTable<RefSubjectTypeEntity> (modelBuilder, "ref_subject_types");
        ConfigureRefTable<RefSyncChangeTypeEntity>(modelBuilder, "ref_sync_change_types");

        modelBuilder.Entity<RefResourceTypeEntity>().HasData(
            new() { Value = "vault",    Description = "A vault — contains documents and folders." },
            new() { Value = "document", Description = "A single document within a vault." });

        modelBuilder.Entity<RefPermissionEntity>().HasData(
            new() { Value = "read",  Description = "Read-only access to the resource." },
            new() { Value = "write", Description = "Read and write access to the resource." },
            new() { Value = "admin", Description = "Full control, including sharing the resource." });

        modelBuilder.Entity<RefVaultRoleEntity>().HasData(
            new() { Value = "owner",  Description = "Vault creator — cannot be removed, has all permissions." },
            new() { Value = "editor", Description = "Can read and write documents." },
            new() { Value = "viewer", Description = "Read-only access to all documents in the vault." });

        modelBuilder.Entity<RefSubjectTypeEntity>().HasData(
            new RefSubjectTypeEntity { Value = "user", Description = "An individual user account." });

        modelBuilder.Entity<RefSyncChangeTypeEntity>().HasData(
            new() { Value = "created",  Description = "Document was created after the sync baseline." },
            new() { Value = "modified", Description = "Document was modified after the sync baseline." },
            new() { Value = "deleted",  Description = "Document was soft-deleted after the sync baseline." },
            new() { Value = "moved",    Description = "Document was moved (reserved — not yet produced by the server)." });

        modelBuilder.Entity<VaultEntity>(e =>
        {
            e.ToTable("vaults");
            e.HasKey(v => v.Id);
            e.Property(v => v.Id).HasColumnName("id");
            e.Property(v => v.Name).HasColumnName("name").IsRequired();
            e.Property(v => v.OwnerId).HasColumnName("owner_id").IsRequired();
            e.Property(v => v.CreatedAt).HasColumnName("created_at").IsRequired();
        });

        modelBuilder.Entity<VaultMemberEntity>(e =>
        {
            e.ToTable("vault_members");
            e.HasKey(m => new { m.VaultId, m.UserId });
            e.Property(m => m.VaultId).HasColumnName("vault_id");
            e.Property(m => m.UserId).HasColumnName("user_id");
            e.Property(m => m.Role).HasColumnName("role").IsRequired();
            e.Property(m => m.JoinedAt).HasColumnName("joined_at").IsRequired();
            e.HasOne(m => m.Vault)
             .WithMany(v => v.Members)
             .HasForeignKey(m => m.VaultId)
             .OnDelete(DeleteBehavior.Cascade);
            e.HasOne<RefVaultRoleEntity>()
             .WithMany()
             .HasForeignKey(m => m.Role)
             .HasPrincipalKey(r => r.Value)
             .OnDelete(DeleteBehavior.Restrict);
        });

        modelBuilder.Entity<FolderEntity>(e =>
        {
            e.ToTable("folders");
            e.HasKey(f => f.Id);
            e.Property(f => f.Id).HasColumnName("id");
            e.Property(f => f.VaultId).HasColumnName("vault_id").IsRequired();
            e.Property(f => f.Path).HasColumnName("path").IsRequired();
            e.Property(f => f.CreatedAt).HasColumnName("created_at").IsRequired();
            e.HasIndex(f => new { f.VaultId, f.Path }).IsUnique();
            e.HasIndex(f => f.VaultId).HasDatabaseName("idx_folders_vault");
            e.HasOne(f => f.Vault)
             .WithMany(v => v.Folders)
             .HasForeignKey(f => f.VaultId)
             .OnDelete(DeleteBehavior.Cascade);
        });

        modelBuilder.Entity<OperationEntity>(e =>
        {
            e.ToTable("operations_log");
            e.HasKey(o => o.Id);
            e.Property(o => o.Id).HasColumnName("id");
            e.Property(o => o.ResourceType).HasColumnName("resource_type").IsRequired();
            e.Property(o => o.ResourceId).HasColumnName("resource_id").IsRequired();
            e.Property(o => o.ClientId).HasColumnName("client_id").IsRequired();
            e.Property(o => o.ProducedAt).HasColumnName("produced_at").IsRequired();
            e.Property(o => o.ReceivedAt).HasColumnName("received_at").IsRequired();
            e.Property(o => o.OpBytes).HasColumnName("op_bytes").IsRequired();
            e.HasIndex(o => new { o.ResourceType, o.ResourceId, o.ReceivedAt })
             .HasDatabaseName("idx_ops_resource");
        });

        modelBuilder.Entity<SyncVectorEntity>(e =>
        {
            e.ToTable("sync_vectors");
            e.HasKey(s => new { s.ResourceId, s.ClientId });
            e.Property(s => s.ResourceId).HasColumnName("resource_id");
            e.Property(s => s.ClientId).HasColumnName("client_id");
            e.Property(s => s.Vector).HasColumnName("vector").IsRequired();
            e.Property(s => s.UpdatedAt).HasColumnName("updated_at").IsRequired();
        });

        modelBuilder.Entity<EdgesyncBlobEntity>(e =>
        {
            e.ToTable("edgesync_blobs");
            e.HasKey(b => new { b.VaultId, b.Key });
            e.Property(b => b.VaultId).HasColumnName("vault_id");
            e.Property(b => b.Key).HasColumnName("key");
            e.Property(b => b.Bytes).HasColumnName("bytes").IsRequired();
            e.Property(b => b.UpdatedAt).HasColumnName("updated_at").IsRequired();
        });

        modelBuilder.Entity<VaultKeyWrapEntity>(e =>
        {
            e.ToTable("vault_key_wraps");
            e.HasKey(w => new { w.UserId, w.VaultId });
            e.Property(w => w.UserId).HasColumnName("user_id");
            e.Property(w => w.VaultId).HasColumnName("vault_id");
            e.Property(w => w.WrappedKeyBytes).HasColumnName("wrapped_key_bytes").IsRequired();
            e.Property(w => w.UpdatedAt).HasColumnName("updated_at").IsRequired();
        });

        modelBuilder.Entity<VaultMemberIdentityEntity>(e =>
        {
            e.ToTable("vault_member_identities");
            e.HasKey(k => new { k.VaultId, k.SignPub });
            e.Property(k => k.VaultId).HasColumnName("vault_id");
            e.Property(k => k.UserId).HasColumnName("user_id").IsRequired();
            e.Property(k => k.SignPub).HasColumnName("sign_pub");
            e.Property(k => k.RegisteredAt).HasColumnName("registered_at").IsRequired();
            e.HasIndex(k => new { k.VaultId, k.UserId });
        });

        modelBuilder.Entity<RefreshToken>(e =>
        {
            e.HasKey(x => x.Id);
            e.HasIndex(x => x.Token).IsUnique();
            e.HasIndex(x => x.UserId);
        });

        modelBuilder.Entity<ResourcePermissionEntity>(e =>
        {
            e.ToTable("resource_permissions");
            e.HasKey(x => x.Id);
            e.Property(x => x.Id).HasColumnName("id");
            e.Property(x => x.ResourceType).HasColumnName("resource_type").IsRequired();
            e.Property(x => x.ResourceId).HasColumnName("resource_id").IsRequired();
            e.Property(x => x.SubjectType).HasColumnName("subject_type").IsRequired();
            e.Property(x => x.SubjectId).HasColumnName("subject_id").IsRequired();
            e.Property(x => x.Permission).HasColumnName("permission").IsRequired();
            e.Property(x => x.GrantedBy).HasColumnName("granted_by").IsRequired();
            e.Property(x => x.GrantedAt).HasColumnName("granted_at").IsRequired();
            e.Property(x => x.ExpiresAt).HasColumnName("expires_at");
            // One ACL entry per subject per resource
            e.HasIndex(x => new { x.ResourceType, x.ResourceId, x.SubjectType, x.SubjectId }).IsUnique()
             .HasDatabaseName("IX_resource_permissions_unique");
            e.HasIndex(x => new { x.ResourceType, x.ResourceId })
             .HasDatabaseName("idx_rp_resource");
            e.HasOne<RefResourceTypeEntity>()
             .WithMany()
             .HasForeignKey(x => x.ResourceType)
             .HasPrincipalKey(r => r.Value)
             .OnDelete(DeleteBehavior.Restrict);
            e.HasOne<RefPermissionEntity>()
             .WithMany()
             .HasForeignKey(x => x.Permission)
             .HasPrincipalKey(r => r.Value)
             .OnDelete(DeleteBehavior.Restrict);
            e.HasOne<RefSubjectTypeEntity>()
             .WithMany()
             .HasForeignKey(x => x.SubjectType)
             .HasPrincipalKey(r => r.Value)
             .OnDelete(DeleteBehavior.Restrict);
        });


        modelBuilder.Entity<ShareLinkEntity>(e =>
        {
            e.ToTable("share_links");
            e.HasKey(x => x.Id);
            e.Property(x => x.Id).HasColumnName("id");
            e.Property(x => x.Token).HasColumnName("token").IsRequired();
            e.Property(x => x.ResourceType).HasColumnName("resource_type").IsRequired();
            e.Property(x => x.ResourceId).HasColumnName("resource_id").IsRequired();
            e.Property(x => x.Permission).HasColumnName("permission").IsRequired();
            e.Property(x => x.CreatedBy).HasColumnName("created_by").IsRequired();
            e.Property(x => x.CreatedAt).HasColumnName("created_at").IsRequired();
            e.Property(x => x.ExpiresAt).HasColumnName("expires_at");
            e.Property(x => x.RevokedAt).HasColumnName("revoked_at");
            e.HasIndex(x => x.Token).IsUnique().HasDatabaseName("IX_share_links_token");
            e.HasIndex(x => new { x.ResourceType, x.ResourceId })
             .HasDatabaseName("idx_sl_resource");
            e.HasOne<RefResourceTypeEntity>()
             .WithMany()
             .HasForeignKey(x => x.ResourceType)
             .HasPrincipalKey(r => r.Value)
             .OnDelete(DeleteBehavior.Restrict);
            e.HasOne<RefPermissionEntity>()
             .WithMany()
             .HasForeignKey(x => x.Permission)
             .HasPrincipalKey(r => r.Value)
             .OnDelete(DeleteBehavior.Restrict);
        });
    }

    private static void ConfigureRefTable<T>(ModelBuilder modelBuilder, string tableName)
        where T : class
    {
        modelBuilder.Entity<T>(e =>
        {
            e.ToTable(tableName);
            e.HasKey("Value");
            e.Property<string>("Value").HasColumnName("value").IsRequired();
            e.Property<string>("Description").HasColumnName("description").IsRequired();
        });
    }
}
