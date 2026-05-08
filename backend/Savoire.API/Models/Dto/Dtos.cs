// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// DTOs de l'API REST — Milestone 1
// Les DTOs sont distincts des domain objects (Records.cs).
// Mapping is done by services (static FromDomain methods).

using Savoire.Server.Models;

namespace Savoire.Server.Models.Dto;

// ── Utilisateurs ───────────────────────────────────────────────────────────

public record UserDto(string Id, string DisplayName)
{
    public static UserDto FromDomain(UserRecord u) => new(u.Id, u.DisplayName);
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
    string              Id,
    string              Name,
    string              Role,
    List<VaultMemberDto> Members,
    int                 DocumentCount,
    int                 FolderCount,
    DateTime            CreatedAt,
    DateTime?           LastModifiedAt,
    long                SizeBytes
);

// ── Documents ──────────────────────────────────────────────────────────────

public record DocumentDto(
    string    Id,
    string    Path,
    string?   Title,
    string    Hash,
    long      SizeBytes,
    DateTime  CreatedAt,
    DateTime  UpdatedAt
)
{
    public static DocumentDto FromDomain(DocumentRecord d) =>
        new(d.Id, d.Path, d.Title, d.Hash, d.SizeBytes, d.CreatedAt, d.UpdatedAt);
}

// ── Dossiers ───────────────────────────────────────────────────────────────

public record FolderDto(string Id, string Path, DateTime CreatedAt)
{
    public static FolderDto FromDomain(FolderRecord f) => new(f.Id, f.Path, f.CreatedAt);
}

// ── Requests ───────────────────────────────────────────────────────────────

public record CreateVaultRequest(string Name);
public record CreateFolderRequest(string Path);
public record PatchVaultRequest(string Name);
public record AddMemberRequest(string UserId, string Role);


// ── Attachments ──────────────────────────────────────────────────────────────

public record AttachmentDto(string FileName, string Path, long Size, string ContentType);
