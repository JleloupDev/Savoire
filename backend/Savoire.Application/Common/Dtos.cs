// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// DTOs de l'API REST — déplacés depuis server/Models/Dto/Dtos.cs.
// Les handlers retournent ces DTOs ; les controllers les sérialisent en JSON.

using Savoire.Domain.Aggregates;

namespace Savoire.Application.Common;

// ── Utilisateurs ───────────────────────────────────────────────────────────

public record UserDto(string Id, string DisplayName)
{
    public static UserDto FromDomain(Domain.Services.UserInfo u) => new(u.Id, u.DisplayName);
}

// ── Vaults ─────────────────────────────────────────────────────────────────

public record VaultSummaryDto(
    string    Id,
    string    Name,
    string    Role,
    int       DocumentCount,
    int       FolderCount,
    DateTime? LastModifiedAt,
    long      SizeBytes
);

public record VaultMemberDto(string UserId, string DisplayName, string Role);

public record VaultDetailDto(
    string               Id,
    string               Name,
    string               Role,
    List<VaultMemberDto> Members,
    int                  DocumentCount,
    int                  FolderCount,
    DateTime             CreatedAt,
    DateTime?            LastModifiedAt,
    long                 SizeBytes
);

// ── Documents ──────────────────────────────────────────────────────────────

public record DocumentDto(
    string   Id,
    string   Path,
    string?  Title,
    string   Hash,
    long     SizeBytes,
    DateTime CreatedAt,
    DateTime UpdatedAt
)
{
    public static DocumentDto FromDomain(Document d) =>
        new(d.Id, d.Path, d.Title, d.Hash, d.SizeBytes, d.CreatedAt, d.UpdatedAt);
}

// ── Dossiers ───────────────────────────────────────────────────────────────

public record FolderDto(string Id, string Path, DateTime CreatedAt)
{
    public static FolderDto FromDomain(Folder f) => new(f.Id, f.Path, f.CreatedAt);
}

public record FolderMoveResultDto(int MovedDocuments, int MovedFolders);

// ── Clone manifest ─────────────────────────────────────────────────────────

public record CloneManifestFolderDto(string Id, string Path);

public record CloneManifestDocumentDto(
    string   Id,
    string   Path,
    string?  Title,
    string   Hash,
    DateTime UpdatedAt,
    long     SizeBytes
);

public record CloneManifestDto(
    string                         VaultId,
    string                         Name,
    string?                        LocalPath,
    List<CloneManifestFolderDto>   Folders,
    List<CloneManifestDocumentDto> Documents,
    int                            TotalDocuments,
    long                           TotalSizeBytes
);

// ── Synchronisation ────────────────────────────────────────────────────────

public record SyncChangeDto(
    string   DocId,
    string   Path,
    string   ChangeType,   // "created" | "modified" | "deleted" | "moved"
    string?  Hash,
    DateTime UpdatedAt
);

public record SyncStatusDto(
    DateTime             Since,
    DateTime             CheckedAt,
    List<SyncChangeDto>  Changes
);

public record SyncRequestDto(string ClientId, byte[] StateVector);
public record SyncResponseDto(byte[][] MissingOps, byte[] ServerStateVector);
public record PushOpsRequestDto(string ClientId, DateTime ProducedAt, byte[] Ops);

// ── Requêtes API (bodies) ──────────────────────────────────────────────────

public record CreateVaultRequest(string Name);
public record CreateDocumentRequest(string Path, string? Content);
public record CreateFolderRequest(string Path);
public record PatchDocumentRequest(string Path);
public record PatchFolderRequest(string Path);
public record PatchVaultRequest(string Name);
public record AddMemberRequest(string UserId, string Role);
public record CloneRequest(string? LocalPath);
public record GrantPermissionRequest(string SubjectId, string Permission, DateTime? ExpiresAt);
public record CreateShareLinkRequest(string Permission, DateTime? ExpiresAt);

// ── Partage ────────────────────────────────────────────────────────────────

/// <summary>Une entrée ACL — permission d'un utilisateur sur une ressource.</summary>
public record ResourcePermissionDto(
    string    Id,
    string    ResourceType,
    string    ResourceId,
    string    SubjectType,
    string    SubjectId,
    string?   SubjectDisplayName,
    string    Permission,
    string    GrantedBy,
    DateTime  GrantedAt,
    DateTime? ExpiresAt
);

/// <summary>Lien de partage — token URL-safe pour accès anonyme ou authentifié.</summary>
public record ShareLinkDto(
    string    Id,
    string    Token,
    string    ResourceType,
    string    ResourceId,
    string    Permission,
    string    CreatedBy,
    DateTime  CreatedAt,
    DateTime? ExpiresAt,
    DateTime? RevokedAt,
    bool      IsValid
);

/// <summary>
/// Aggregation des droits d'accès d'une ressource (permissions utilisateurs + liens).
/// </summary>
public record ResourceSharingDto(
    string                      ResourceType,
    string                      ResourceId,
    List<ResourcePermissionDto> Permissions,
    List<ShareLinkDto>          Links
);

/// <summary>JWT scoped retourné après validation d'un lien de partage.</summary>
public record ShareLinkAccessDto(
    string    AccessToken,
    string    ResourceType,
    string    ResourceId,
    string    Permission,
    DateTime? ExpiresAt,
    /// <summary>Renseigné pour ResourceType=document afin que le client puisse charger le contenu.</summary>
    string?   VaultId = null
);

// ── View grants (iframe bootstrap) ──────────────────────────────────────────

public record CreateViewGrantRequest(
    string? VaultId,
    string? DocId,
    string? Path,
    string? Permission,
    string? ShareToken
);

public record ViewGrantDto(
    string GrantToken,
    string VaultId,
    string DocId,
    string Path,
    string Permission,
    DateTime ExpiresAt
);

public record RedeemViewGrantRequest(string GrantToken);

// ── Métadonnées & Index ─────────────────────────────────────────────────────

public record DocumentMetaDto(
    string   DocumentId,
    string   ContentType,
    string?  DerivedFrom,
    string?  DerivedBy,
    string[] Tags,
    string   FrontmatterJson,
    DateTime IndexedAt
);

public record BacklinkDto(
    string DocId,
    string Path,
    string? Title,
    string LinkType
);

public record VaultLinkDto(
    string  SourceId,
    string  SourcePath,
    string? TargetId,
    string  TargetPath,
    string  LinkType
);

public record IndexSnapshotDto(
    string Namespace,
    long   ProcessedSeq,
    string Data,
    DateTime CreatedAt
);

public record SaveIndexSnapshotRequest(
    string Namespace,
    long   ProcessedSeq,
    string Data
);

public record ViewAccessDto(
    string AccessToken,
    string VaultId,
    string DocId,
    string Path,
    string Permission,
    DateTime ExpiresAt,
    string? UserId = null
);
