// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// MediatR handlers broadcasting document metadata events to non-vault-member
// subscribers via the SyncHub doc-events group.
// see ADR-028

using MediatR;
using Microsoft.AspNetCore.SignalR;
using Savoire.Application.Notifications;
using Savoire.Server.Hubs;

namespace Savoire.Server.Notifications;

/// <summary>
/// Sends DocumentRenamed to users in doc-events:{DocId} (non-vault-members
/// who have document-level permission and joined via JoinDocument).
/// </summary>
public class SyncHubDocumentRenamedHandler(IHubContext<SyncHub> hub)
    : INotificationHandler<DocumentRenamedNotification>
{
    public Task Handle(DocumentRenamedNotification n, CancellationToken ct) =>
        hub.Clients.Group($"doc-events:{n.DocId}").SendAsync(
            "DocumentRenamed", n.DocId, n.NewPath, ct);
}

/// <summary>
/// Sends DocumentDeleted to users in doc-events:{DocId}.
/// </summary>
public class SyncHubDocumentDeletedHandler(IHubContext<SyncHub> hub)
    : INotificationHandler<DocumentDeletedNotification>
{
    public Task Handle(DocumentDeletedNotification n, CancellationToken ct) =>
        hub.Clients.Group($"doc-events:{n.DocId}").SendAsync(
            "DocumentDeleted", n.DocId, ct);
}

/// <summary>
/// Sends AccessRevoked to users in doc-events:{DocId} with the target user id
/// so clients can determine if the revocation concerns them.
/// </summary>
public class SyncHubAccessRevokedHandler(IHubContext<SyncHub> hub)
    : INotificationHandler<AccessRevokedNotification>
{
    public Task Handle(AccessRevokedNotification n, CancellationToken ct) =>
        hub.Clients.Group($"doc-events:{n.DocId}").SendAsync(
            "AccessRevoked", n.DocId, n.TargetUserId, ct);
}
