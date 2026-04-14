// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// MediatR notifications published by document handlers.
// see ADR-001

using MediatR;

namespace Savoire.Application.Notifications;

public record DocumentCreatedNotification(
    string    DocId,
    string    VaultId,
    string    Path,
    string?   Title,
    DateTime  CreatedAt,
    DateTime  UpdatedAt
) : INotification;

public record DocumentRenamedNotification(
    string   DocId,
    string   VaultId,
    string   OldPath,
    string   NewPath,
    DateTime UpdatedAt
) : INotification;

public record DocumentDeletedNotification(
    string   DocId,
    string   VaultId,
    string   Path,
    DateTime DeletedAt
) : INotification;

/// <summary>
/// Published after a document's content has been saved/indexed.
/// Triggers the update of metadata (tags, wikilinks) in the projection.
/// </summary>
public record DocumentContentIndexedNotification(
    string DocId,
    string VaultId,
    string MarkdownContent  // text extracted from the CRDT or the shadow doc
) : INotification;

/// <summary>
/// Published after a rename — tells clients which documents contain
/// wikilinks pointing to the old path and need to be updated.
/// </summary>
public record WikilinkCascadeNotification(
    string VaultId,
    string OldPath,
    string NewPath,
    IReadOnlyList<string> AffectedDocIds  // documents containing [[OldPath]]
) : INotification;

/// <summary>
/// Published after a document-level permission is revoked.
/// Notifies the target user's open editor sessions via SyncHub.
/// </summary>
public record AccessRevokedNotification(
    string DocId,
    string TargetUserId
) : INotification;
