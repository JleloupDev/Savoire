// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// EF Core entities — mapped to Domain aggregates via Rehydrate().

using Savoire.Domain.Aggregates;
using Savoire.Domain.Enums;

namespace Savoire.Infrastructure.Persistence;

public class VaultEntity
{
    public string Id        { get; set; } = null!;
    public string Name      { get; set; } = null!;
    public string OwnerId   { get; set; } = null!;
    public DateTime CreatedAt { get; set; }

    public ICollection<VaultMemberEntity> Members   { get; set; } = [];
    public ICollection<DocumentEntity>    Documents { get; set; } = [];
    public ICollection<FolderEntity>      Folders   { get; set; } = [];

    public Vault ToDomain() => Vault.Rehydrate(Id, Name, OwnerId, CreatedAt);
}

public class VaultMemberEntity
{
    public string   VaultId  { get; set; } = null!;
    public string   UserId   { get; set; } = null!;
    public string   Role     { get; set; } = null!;
    public DateTime JoinedAt { get; set; }

    public VaultEntity Vault { get; set; } = null!;

    public VaultMember ToDomain() => new(VaultId, UserId, Role.ParseVaultRole(), JoinedAt);
}

public class DocumentEntity
{
    public string    Id        { get; set; } = null!;
    public string    VaultId   { get; set; } = null!;
    public string    Path      { get; set; } = null!;
    public string?   Title     { get; set; }
    public long      SizeBytes { get; set; }
    public string    Hash      { get; set; } = "";
    public DateTime  CreatedAt { get; set; }
    public DateTime  UpdatedAt { get; set; }
    public DateTime? DeletedAt { get; set; }

    public VaultEntity Vault { get; set; } = null!;

    public Document ToDomain() =>
        Document.Rehydrate(Id, VaultId, Path, Title, SizeBytes, Hash, CreatedAt, UpdatedAt, DeletedAt);
}

public class FolderEntity
{
    public string   Id        { get; set; } = null!;
    public string   VaultId   { get; set; } = null!;
    public string   Path      { get; set; } = null!;
    public DateTime CreatedAt { get; set; }

    public VaultEntity Vault { get; set; } = null!;

    public Folder ToDomain() => Folder.Rehydrate(Id, VaultId, Path, CreatedAt);
}

public class OperationEntity
{
    public string   Id           { get; set; } = null!;
    public string   ResourceType { get; set; } = null!;
    public string   ResourceId   { get; set; } = null!;
    public string   ClientId     { get; set; } = null!;
    public DateTime ProducedAt   { get; set; }
    public DateTime ReceivedAt   { get; set; }
    public byte[]   OpBytes      { get; set; } = null!;

    public Operation ToDomain() =>
        Operation.Rehydrate(Id, ResourceType, ResourceId, ClientId, ProducedAt, ReceivedAt, OpBytes);
}

public class SyncVectorEntity
{
    public string   ResourceId { get; set; } = null!;
    public string   ClientId   { get; set; } = null!;
    public byte[]   Vector     { get; set; } = null!;
    public DateTime UpdatedAt  { get; set; }
}

public class ResourcePermissionEntity
{
    public string    Id           { get; set; } = null!;
    public string    ResourceType { get; set; } = null!;
    public string    ResourceId   { get; set; } = null!;
    public string    SubjectType  { get; set; } = null!;
    public string    SubjectId    { get; set; } = null!;
    public string    Permission   { get; set; } = null!;
    public string    GrantedBy    { get; set; } = null!;
    public DateTime  GrantedAt    { get; set; }
    public DateTime? ExpiresAt    { get; set; }

    public ResourcePermission ToDomain() =>
        ResourcePermission.Rehydrate(
            Id,
            ResourceType.ParseResourceType(),
            ResourceId,
            SubjectType.ParseSubjectType(),
            SubjectId,
            Permission.ParsePermission(),
            GrantedBy, GrantedAt, ExpiresAt);
}


public class IndexSnapshotEntity
{
    public string   Id           { get; set; } = null!;
    public string   VaultId      { get; set; } = null!;
    public string   Namespace    { get; set; } = null!;
    public long     ProcessedSeq { get; set; }
    public string   Data         { get; set; } = null!;
    public DateTime CreatedAt    { get; set; }

    public IndexSnapshot ToDomain() =>
        IndexSnapshot.Rehydrate(Id, VaultId, Namespace, ProcessedSeq, Data, CreatedAt);
}

// ── Reference / lookup tables ────────────────────────────────────────────────
// One table per enum. Values are the canonical API strings from ToApiString().
// FK constraints from child tables enforce referential integrity at DB level.

public class RefResourceTypeEntity  { public string Value { get; set; } = null!; public string Description { get; set; } = null!; }
public class RefPermissionEntity    { public string Value { get; set; } = null!; public string Description { get; set; } = null!; }
public class RefVaultRoleEntity     { public string Value { get; set; } = null!; public string Description { get; set; } = null!; }
public class RefSubjectTypeEntity   { public string Value { get; set; } = null!; public string Description { get; set; } = null!; }
public class RefSyncChangeTypeEntity{ public string Value { get; set; } = null!; public string Description { get; set; } = null!; }

public class ShareLinkEntity
{
    public string    Id           { get; set; } = null!;
    public string    Token        { get; set; } = null!;
    public string    ResourceType { get; set; } = null!;
    public string    ResourceId   { get; set; } = null!;
    public string    Permission   { get; set; } = null!;
    public string    CreatedBy    { get; set; } = null!;
    public DateTime  CreatedAt    { get; set; }
    public DateTime? ExpiresAt    { get; set; }
    public DateTime? RevokedAt    { get; set; }

    public ShareLink ToDomain() =>
        ShareLink.Rehydrate(
            Id, Token,
            ResourceType.ParseResourceType(),
            ResourceId,
            Permission.ParsePermission(),
            CreatedBy, CreatedAt, ExpiresAt, RevokedAt);
}

