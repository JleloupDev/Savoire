// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
using MediatR;

namespace Savoire.Application.Notifications;

/// <summary>
/// Published after a document's content has been saved/indexed.
/// Triggers the update of metadata (tags, wikilinks) in the projection.
/// </summary>
public record DocumentContentIndexedNotification(
    string DocId,
    string VaultId,
    string MarkdownContent
) : INotification;

/// <summary>
/// Published after a document-level permission is revoked.
/// Notifies the target user's open editor sessions via SyncHub.
/// </summary>
public record AccessRevokedNotification(
    string DocId,
    string TargetUserId
) : INotification;

/// <summary>
/// Published whenever a vault's membership changes (grant/revoke, add/remove
/// member) -- pushed to connected edgesync peers so they refresh their
/// authorized-signPub set without waiting for the polling fallback. See
/// EdgeSyncHubMembershipChangedHandler and MembershipSource.ts.
/// </summary>
public record VaultMembershipChangedNotification(
    string VaultId
) : INotification;
