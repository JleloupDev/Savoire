// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
namespace Savoire.Server.Hubs;

public sealed record VaultSnapshotItem(string Id, string Path, string? Title, DateTime UpdatedAt);
public sealed record DocumentCreatedEvent(string Id, string VaultId, string Path, string? Title, DateTime CreatedAt);
public sealed record DocumentRenamedEvent(string Id, string OldPath, string NewPath, DateTime UpdatedAt);
public sealed record DocumentDeletedEvent(string Id, string Path, DateTime DeletedAt);

// ── Index ops ─────────────────────────────────────────────────────────────────

/// <summary>Payload sent by the client to index a document.</summary>
public sealed record PushIndexOpDto(
    string VaultId,
    string DocId,
    string Path,
    string MarkdownContent);

/// <summary>
/// Broadcast after sequencing an index op.
/// Seq is the global sequence number assigned by the server.
/// </summary>
public sealed record IndexOpAppliedEvent(
    long   Seq,
    string DocId,
    string Path,
    string MarkdownContent);
