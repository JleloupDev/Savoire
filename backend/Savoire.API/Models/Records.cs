// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// Data models — Milestone 1

namespace Savoire.Server.Models;

public record UserRecord(string Id, string DisplayName, string DefaultVaultPath);

public record VaultRecord(
    string Id,
    string Name,
    string OwnerId,
    DateTime CreatedAt
);

public record VaultMember(
    string VaultId,
    string UserId,
    string Role,           // "owner" | "editor" | "viewer"
    DateTime JoinedAt
);

public record DocumentRecord(
    string Id,
    string VaultId,
    string Path,           // relative path within the vault, e.g. "Inbox/note.md"
    string? Title,         // extracted from H1 or frontmatter
    long SizeBytes,
    string Hash,           // SHA-256 du contenu .md courant — non-nullable, default ''
    DateTime CreatedAt,
    DateTime UpdatedAt,
    DateTime? DeletedAt = null
);

public record FolderRecord(
    string Id,
    string VaultId,
    string Path,           // chemin relatif, ex: "Projets/Alpha"
    DateTime CreatedAt
);

public record OperationRecord(
    string Id,
    string DocumentId,
    string ClientId,
    DateTime ProducedAt,
    DateTime ReceivedAt,
    byte[] OpBytes
);

public record SyncVector(
    string DocumentId,
    string ClientId,
    byte[] Vector,
    DateTime UpdatedAt
);

// ── Vault statistics (computed by SQL) ────────────────────────────────────

public record VaultStats(
    int       DocumentCount,
    int       FolderCount,
    DateTime? LastModifiedAt,
    long      SizeBytes
);
