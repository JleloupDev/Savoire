// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
using MediatR;
using Microsoft.AspNetCore.SignalR;
using Savoire.Application.Notifications;
using Savoire.Server.Hubs;

namespace Savoire.Server.Notifications;

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

/// <summary>
/// Pushes MembershipChanged to edge:{vaultId} — the same SignalR group
/// EdgeSyncHub already uses for PeerUp/PeerDown — so connected edgesync
/// sessions refresh their authorized-signPub set without waiting for the
/// polling fallback. Reuses the existing relay connection; no new hub.
/// </summary>
public class EdgeSyncHubMembershipChangedHandler(IHubContext<EdgeSyncHub> hub)
    : INotificationHandler<VaultMembershipChangedNotification>
{
    public Task Handle(VaultMembershipChangedNotification n, CancellationToken ct) =>
        hub.Clients.Group($"edge:{n.VaultId}").SendAsync(
            "MembershipChanged", n.VaultId, ct);
}
