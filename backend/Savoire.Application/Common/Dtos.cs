// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// REST API DTOs — moved from server/Models/Dto/Dtos.cs.
// Handlers return these DTOs; controllers serialize them to JSON.

using Savoire.Domain.Aggregates;

namespace Savoire.Application.Common;

// ── Users ──────────────────────────────────────────────────────────────────

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

public record SharedNoteDto(
    string DocumentId,
    string VaultId,
    string Path,
    string Permission,
    string GrantedByDisplayName
);

public record WorkspaceDto(
    IReadOnlyList<VaultSummaryDto> Vaults,
    IReadOnlyList<SharedNoteDto>   SharedWithMe
);

// ── Folders ────────────────────────────────────────────────────────────────

public record FolderDto(string Id, string Path, DateTime CreatedAt)
{
    public static FolderDto FromDomain(Folder f) => new(f.Id, f.Path, f.CreatedAt);
}

// ── API Request bodies ─────────────────────────────────────────────────────

public record CreateVaultRequest(string Name);
public record CreateFolderRequest(string Path);
public record PatchVaultRequest(string Name);
public record AddMemberRequest(string UserId, string Role);
public record RegisterVaultMemberIdentityRequest(string SignPubBase64);
public record GrantPermissionRequest(string SubjectId, string Permission, DateTime? ExpiresAt);
public record CreateShareLinkRequest(string Permission, DateTime? ExpiresAt);

// ── Sharing ────────────────────────────────────────────────────────────────

/// <summary>An ACL entry — a user's permission on a resource.</summary>
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

/// <summary>Share link — URL-safe token for anonymous or authenticated access.</summary>
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
/// Aggregation of a resource's access rights (user permissions + links).
/// </summary>
public record ResourceSharingDto(
    string                      ResourceType,
    string                      ResourceId,
    List<ResourcePermissionDto> Permissions,
    List<ShareLinkDto>          Links
);

/// <summary>Scoped JWT returned after a share link is validated.</summary>
public record ShareLinkAccessDto(
    string    AccessToken,
    string    ResourceType,
    string    ResourceId,
    string    Permission,
    DateTime? ExpiresAt,
    /// <summary>Populated for ResourceType=document so the client can load the content.</summary>
    string?   VaultId = null,
    /// <summary>Document path (e.g. "notes/hello.excalidraw") — drives editor type selection on the client.</summary>
    string?   Path = null
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

// ── Metadata & Index ───────────────────────────────────────────────────────

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

public record EdgesyncBlobDto(
    string BytesBase64
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
