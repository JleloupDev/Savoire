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
    public DbSet<VaultEntity>       Vaults      => Set<VaultEntity>();
    public DbSet<VaultMemberEntity> VaultMembers => Set<VaultMemberEntity>();
    public DbSet<DocumentEntity>    Documents   => Set<DocumentEntity>();
    public DbSet<FolderEntity>      Folders     => Set<FolderEntity>();
    public DbSet<OperationEntity>   Operations  => Set<OperationEntity>();
    public DbSet<SyncVectorEntity>  SyncVectors => Set<SyncVectorEntity>();
    public DbSet<RefreshToken>              RefreshTokens       => Set<RefreshToken>();
    public DbSet<ResourcePermissionEntity>  ResourcePermissions => Set<ResourcePermissionEntity>();
    public DbSet<ShareLinkEntity>           ShareLinks          => Set<ShareLinkEntity>();
    public DbSet<DocumentMetaEntity>        DocumentMetas       => Set<DocumentMetaEntity>();
    public DbSet<DocLinkEntity>             DocLinks            => Set<DocLinkEntity>();
    public DbSet<IndexSnapshotEntity>       IndexSnapshots      => Set<IndexSnapshotEntity>();

    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        base.OnModelCreating(modelBuilder);  // REQUIRED for Identity

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
        });

        modelBuilder.Entity<DocumentEntity>(e =>
        {
            e.ToTable("documents");
            e.HasKey(d => d.Id);
            e.Property(d => d.Id).HasColumnName("id");
            e.Property(d => d.VaultId).HasColumnName("vault_id").IsRequired();
            e.Property(d => d.Path).HasColumnName("path").IsRequired();
            e.Property(d => d.Title).HasColumnName("title");
            e.Property(d => d.SizeBytes).HasColumnName("size_bytes").HasDefaultValue(0L);
            e.Property(d => d.Hash).HasColumnName("hash").HasDefaultValue("").IsRequired();
            e.Property(d => d.CreatedAt).HasColumnName("created_at").IsRequired();
            e.Property(d => d.UpdatedAt).HasColumnName("updated_at").IsRequired();
            e.Property(d => d.DeletedAt).HasColumnName("deleted_at");
            e.HasIndex(d => new { d.VaultId, d.Path }).IsUnique();
            e.HasIndex(d => new { d.VaultId, d.DeletedAt }).HasDatabaseName("idx_documents_vault");
            e.HasOne(d => d.Vault)
             .WithMany(v => v.Documents)
             .HasForeignKey(d => d.VaultId)
             .OnDelete(DeleteBehavior.Cascade);
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
            e.Property(o => o.DocumentId).HasColumnName("document_id").IsRequired();
            e.Property(o => o.ClientId).HasColumnName("client_id").IsRequired();
            e.Property(o => o.ProducedAt).HasColumnName("produced_at").IsRequired();
            e.Property(o => o.ReceivedAt).HasColumnName("received_at").IsRequired();
            e.Property(o => o.OpBytes).HasColumnName("op_bytes").IsRequired();
            e.HasIndex(o => new { o.DocumentId, o.ReceivedAt })
             .HasDatabaseName("idx_ops_document");
        });

        modelBuilder.Entity<SyncVectorEntity>(e =>
        {
            e.ToTable("sync_vectors");
            e.HasKey(s => new { s.DocumentId, s.ClientId });
            e.Property(s => s.DocumentId).HasColumnName("document_id");
            e.Property(s => s.ClientId).HasColumnName("client_id");
            e.Property(s => s.Vector).HasColumnName("vector").IsRequired();
            e.Property(s => s.UpdatedAt).HasColumnName("updated_at").IsRequired();
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
        });

        modelBuilder.Entity<DocumentMetaEntity>(e =>
        {
            e.ToTable("document_metas");
            e.HasKey(x => x.DocumentId);
            e.Property(x => x.DocumentId).HasColumnName("document_id");
            e.Property(x => x.VaultId).HasColumnName("vault_id").IsRequired();
            e.Property(x => x.ContentType).HasColumnName("content_type").HasDefaultValue("text/markdown");
            e.Property(x => x.DerivedFrom).HasColumnName("derived_from");
            e.Property(x => x.DerivedBy).HasColumnName("derived_by");
            e.Property(x => x.Tags).HasColumnName("tags").HasDefaultValue("[]");
            e.Property(x => x.Frontmatter).HasColumnName("frontmatter").HasDefaultValue("{}");
            e.Property(x => x.IndexedAt).HasColumnName("indexed_at").IsRequired();
            e.HasIndex(x => x.VaultId).HasDatabaseName("idx_doc_metas_vault");
            e.HasIndex(x => x.DerivedFrom).HasDatabaseName("idx_doc_metas_derived_from");
        });

        modelBuilder.Entity<DocLinkEntity>(e =>
        {
            e.ToTable("doc_links");
            e.HasKey(x => x.Id);
            e.Property(x => x.Id).HasColumnName("id");
            e.Property(x => x.SourceId).HasColumnName("source_id").IsRequired();
            e.Property(x => x.VaultId).HasColumnName("vault_id").IsRequired();
            e.Property(x => x.TargetId).HasColumnName("target_id");
            e.Property(x => x.TargetPath).HasColumnName("target_path").IsRequired();
            e.Property(x => x.LinkType).HasColumnName("link_type").HasDefaultValue("wikilink");
            e.HasIndex(x => x.SourceId).HasDatabaseName("idx_doc_links_source");
            e.HasIndex(x => x.TargetId).HasDatabaseName("idx_doc_links_target");
            e.HasIndex(x => new { x.VaultId, x.TargetPath }).HasDatabaseName("idx_doc_links_target_path");
        });

        modelBuilder.Entity<IndexSnapshotEntity>(e =>
        {
            e.ToTable("index_snapshots");
            e.HasKey(x => x.Id);
            e.Property(x => x.Id).HasColumnName("id");
            e.Property(x => x.VaultId).HasColumnName("vault_id").IsRequired();
            e.Property(x => x.Namespace).HasColumnName("namespace").IsRequired();
            e.Property(x => x.ProcessedSeq).HasColumnName("processed_seq").IsRequired();
            e.Property(x => x.Data).HasColumnName("data").IsRequired();
            e.Property(x => x.CreatedAt).HasColumnName("created_at").IsRequired();
            e.HasIndex(x => new { x.VaultId, x.Namespace }).HasDatabaseName("idx_snapshots_vault_ns");
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
        });
    }
}
