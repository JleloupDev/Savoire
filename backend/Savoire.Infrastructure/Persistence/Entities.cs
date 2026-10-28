// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// EF Core entities -- mapped to Domain aggregates via Rehydrate().

using Savoire.Domain.Aggregates;
using Savoire.Domain.Enums;

namespace Savoire.Infrastructure.Persistence;

public class VaultEntity
{
    public string   Id        { get; set; } = null!;
    public string   Name      { get; set; } = null!;
    public string   OwnerId   { get; set; } = null!;
    public DateTime CreatedAt { get; set; }

    public ICollection<VaultMemberEntity> Members { get; set; } = [];
    public ICollection<FolderEntity>      Folders { get; set; } = [];

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

public class EdgesyncBlobEntity
{
    public string   VaultId   { get; set; } = null!;
    public string   Key       { get; set; } = null!;
    public byte[]   Bytes     { get; set; } = null!;
    public DateTime UpdatedAt { get; set; }
}

/// <summary>Registre « document -> vault » (voir IVaultDocumentRepository).</summary>
public class VaultDocumentEntity
{
    public string   DocId        { get; set; } = null!;
    public string   VaultId      { get; set; } = null!;
    public string   RegisteredBy { get; set; } = null!;
    public DateTime RegisteredAt { get; set; }
    /// <summary>Piece jointe rangee dans le dossier de cette note (null : ailleurs).</summary>
    public string?  ParentDocId  { get; set; }
    /// <summary>Nom affiche d'une piece jointe (« Photo.png »), pour la page de partage.</summary>
    public string?  Name         { get; set; }
}

/// <summary>
/// Flux de changements du pair indexeur : une ligne par ressource (arborescence
/// d'un vault, document), deplacee en fin de flux a chaque ecriture, plus une
/// ligne par vault supprime. Seq vient d'AUTOINCREMENT : jamais reutilisee.
/// </summary>
public class IndexerChangeEntity
{
    public long     Seq         { get; set; }
    /// <summary>« vault:{id} », « document:{id} » ou « vault-deleted:{id} » : unique.</summary>
    public string   ResourceKey { get; set; } = null!;
    public string   VaultId     { get; set; } = null!;
    public string   Kind        { get; set; } = null!;
    public string?  DocId       { get; set; }
    public DateTime ChangedAt   { get; set; }
}

/// <summary>Etat du flux (cle « epoch » : identifiant de la base, voir IIndexerChangeRepository).</summary>
public class IndexerFeedStateEntity
{
    public string Key   { get; set; } = null!;
    public string Value { get; set; } = null!;
}

/// <summary>Reglage « pair qui sert le vault ». Pas de ligne : pair gere.</summary>
public class VaultIndexerSettingEntity
{
    public string   VaultId   { get; set; } = null!;
    public string   Mode      { get; set; } = null!;
    public string?  Url       { get; set; }
    public string   UpdatedBy { get; set; } = null!;
    public DateTime UpdatedAt { get; set; }
}

public class VaultKeyWrapEntity
{
    public string   UserId          { get; set; } = null!;
    public string   VaultId         { get; set; } = null!;
    public byte[]   WrappedKeyBytes { get; set; } = null!;
    public DateTime UpdatedAt       { get; set; }
}

// Identites edgesync (signPub Ed25519) qu'un compte a enregistrees pour un
// vault -- le pont entre l'ACL classique (vault_members, indexee par
// userId) et le protocole (qui ne connait que des signPub). Purement
// publique, aucune cle privee ici. Un compte peut avoir plusieurs signPub
// pour un meme vault (identite renouvelee) -- toutes restent valides tant
// que le compte est membre.
public class VaultMemberIdentityEntity
{
    public string   VaultId      { get; set; } = null!;
    public string   UserId       { get; set; } = null!;
    public byte[]   SignPub      { get; set; } = null!;
    public DateTime RegisteredAt { get; set; }
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

// ── Reference / lookup tables ─────────────────────────────────────────────────

public class RefResourceTypeEntity   { public string Value { get; set; } = null!; public string Description { get; set; } = null!; }
public class RefPermissionEntity     { public string Value { get; set; } = null!; public string Description { get; set; } = null!; }
public class RefVaultRoleEntity      { public string Value { get; set; } = null!; public string Description { get; set; } = null!; }
public class RefSubjectTypeEntity    { public string Value { get; set; } = null!; public string Description { get; set; } = null!; }
public class RefSyncChangeTypeEntity { public string Value { get; set; } = null!; public string Description { get; set; } = null!; }

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
