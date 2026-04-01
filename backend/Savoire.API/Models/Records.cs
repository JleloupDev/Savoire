// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// Modèles de données — Milestone 1
// Conforme à docs/Claude/03/MILESTONE_1_SPECS.md § Domain objects

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
    string Path,           // chemin relatif dans le vault, ex: "Inbox/idée.md"
    string? Title,         // extrait du H1 ou du frontmatter
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

// ── Statistiques vault (calculées par SQL) ─────────────────────────────────

public record VaultStats(
    int       DocumentCount,
    int       FolderCount,
    DateTime? LastModifiedAt,
    long      SizeBytes
);
