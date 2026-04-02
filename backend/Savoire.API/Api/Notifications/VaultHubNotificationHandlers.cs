// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// MediatR handlers for broadcasting document events via SignalR.
// see ADR-001

using MediatR;
using Microsoft.AspNetCore.SignalR;
using Savoire.Application.Notifications;

using Savoire.Server.Hubs;

namespace Savoire.Server.Notifications;

public class VaultHubDocumentCreatedHandler(IHubContext<VaultHub> hub)
    : INotificationHandler<DocumentCreatedNotification>
{
    public Task Handle(DocumentCreatedNotification n, CancellationToken ct) =>
        hub.Clients.Group(n.VaultId).SendAsync(
            "DocumentCreated",
            new DocumentCreatedEvent(n.DocId, n.VaultId, n.Path, n.Title, n.CreatedAt),
            ct);
}

public class VaultHubDocumentRenamedHandler(IHubContext<VaultHub> hub)
    : INotificationHandler<DocumentRenamedNotification>
{
    public Task Handle(DocumentRenamedNotification n, CancellationToken ct) =>
        hub.Clients.Group(n.VaultId).SendAsync(
            "DocumentRenamed",
            new DocumentRenamedEvent(n.DocId, n.OldPath, n.NewPath, n.UpdatedAt),
            ct);
}

public class VaultHubDocumentDeletedHandler(IHubContext<VaultHub> hub)
    : INotificationHandler<DocumentDeletedNotification>
{
    public Task Handle(DocumentDeletedNotification n, CancellationToken ct) =>
        hub.Clients.Group(n.VaultId).SendAsync(
            "DocumentDeleted",
            new DocumentDeletedEvent(n.DocId, n.Path, n.DeletedAt),
            ct);
}

public class VaultHubWikilinkCascadeHandler(IHubContext<VaultHub> hub)
    : INotificationHandler<WikilinkCascadeNotification>
{
    public Task Handle(WikilinkCascadeNotification n, CancellationToken ct) =>
        hub.Clients.Group(n.VaultId).SendAsync(
            "WikilinkCascade",
            new { n.OldPath, n.NewPath, n.AffectedDocIds },
            ct);
}
