// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// Abonnements temps reel (groupes des hubs), reverifies quand un droit change
// (revue du 14/11/2026, M7).
//
// Avant : retirer un membre, revoquer un lien ou laisser expirer un droit ne
// touchait pas les connexions deja ouvertes. Le serveur prevenait le client
// (« VaultAccessChanged »), mais le laissait dans les groupes : il continuait
// de RECEVOIR les modifications des autres, tant que sa connexion durait.
// Chaque ecriture, elle, est deja recontrolee a chaque appel.
//
// Maintenant : chaque entree dans un groupe lie a un vault ou a un document
// est notee ici. Quand l'acces d'un vault change (membre retire, droit
// expire, lien revoque, compte bloque ou supprime), les abonnements concernes
// sont recontroles ; ceux qui n'ont plus le droit sont sortis du groupe, et
// la connexion est prevenue (« AccessRevoked »).

using System.Collections.Concurrent;
using MediatR;
using Microsoft.AspNetCore.SignalR;
using Savoire.Application.Common;
using Savoire.Application.Sync.Access;

namespace Savoire.Server.Hubs;

public enum HubKind { Vault, Sync, Room, EdgeSync }

/// <summary>Un abonnement : une connexion, dans un groupe, au titre d'un vault (et d'un document).</summary>
public sealed record HubSubscription(HubKind Hub, string ConnectionId, string CallerId, string VaultId, string? DocId, string Group);

public sealed class HubSubscriptions(IServiceScopeFactory scopes, ILogger<HubSubscriptions> logger)
{
    /// <summary>Par connexion : ses abonnements (cle : groupe).</summary>
    private readonly ConcurrentDictionary<string, ConcurrentDictionary<string, HubSubscription>> byConnection = new();

    public void Add(HubKind hub, string connectionId, string callerId, string vaultId, string? docId, string group) =>
        byConnection.GetOrAdd(connectionId, _ => new())[group] = new HubSubscription(hub, connectionId, callerId, vaultId, docId, group);

    public void Remove(string connectionId, string group)
    {
        if (byConnection.TryGetValue(connectionId, out var groups)) groups.TryRemove(group, out _);
    }

    public void Forget(string connectionId) => byConnection.TryRemove(connectionId, out _);

    public IReadOnlyList<HubSubscription> All() => byConnection.Values.SelectMany(g => g.Values).ToList();

    /// <summary>Reverifie les abonnements de ce vault (ou de ce compte), sort ceux qui n'ont plus le droit.</summary>
    public Task RecheckVaultAsync(string vaultId, CancellationToken ct = default) =>
        RecheckAsync(All().Where(s => s.VaultId == vaultId).ToList(), ct);

    public Task RecheckCallerAsync(string callerId, CancellationToken ct = default) =>
        RecheckAsync(All().Where(s => s.CallerId == callerId).ToList(), ct);

    public Task RecheckDocumentAsync(string docId, CancellationToken ct = default) =>
        RecheckAsync(All().Where(s => s.DocId == docId).ToList(), ct);

    public Task RecheckAllAsync(CancellationToken ct = default) => RecheckAsync(All(), ct);

    private async Task RecheckAsync(IReadOnlyList<HubSubscription> subscriptions, CancellationToken ct)
    {
        if (subscriptions.Count == 0) return;
        await using AsyncServiceScope scope = scopes.CreateAsyncScope();
        IServiceProvider sp = scope.ServiceProvider;
        var mediator = sp.GetRequiredService<IMediator>();
        var verdicts = new Dictionary<(string, string, string?), bool>();
        foreach (HubSubscription s in subscriptions)
        {
            var key = (s.CallerId, s.VaultId, s.DocId);
            if (!verdicts.TryGetValue(key, out bool allowed))
            {
                allowed = await AllowedAsync(sp, mediator, s, ct);
                verdicts[key] = allowed;
            }
            if (allowed) continue;
            Remove(s.ConnectionId, s.Group);
            IHubClients clients = Clients(sp, s.Hub, out IGroupManager groups);
            await groups.RemoveFromGroupAsync(s.ConnectionId, s.Group, ct);
            await clients.Client(s.ConnectionId).SendAsync("AccessRevoked", s.DocId ?? s.VaultId, s.CallerId, ct);
            logger.LogInformation("Abonnement retire : {Hub} {Group} (droit perdu)", s.Hub, s.Group);
        }
    }

    private static async Task<bool> AllowedAsync(IServiceProvider sp, IMediator mediator, HubSubscription s, CancellationToken ct)
    {
        // Un compte bloque ou supprime n'a plus rien : le controle des droits,
        // lui, ne regarde que les vaults (le blocage est verifie a la connexion).
        if (!Savoire.Application.Sharing.ShareLinkGuard.IsShareLinkCaller(s.CallerId) && !Savoire.Application.Sharing.ShareLinkGuard.IsViewCaller(s.CallerId))
        {
            var users = sp.GetRequiredService<Microsoft.AspNetCore.Identity.UserManager<Savoire.Domain.Entities.AppUser>>();
            var user = await users.FindByIdAsync(s.CallerId);
            if (user is null || (user.LockoutEnd is { } end && end > DateTimeOffset.UtcNow)) return false;
        }
        try
        {
            if (s.DocId is null) await mediator.Send(new CheckVaultAccessQuery(s.CallerId, s.VaultId, VaultAccessLevel.Read), ct);
            else await mediator.Send(new CheckDocumentAccessQuery(s.CallerId, s.VaultId, s.DocId, VaultAccessLevel.Read), ct);
            return true;
        }
        catch (Exception ex) when (HubErrorFilter.CodeOf(ex) is not null || ex is UnauthorizedAccessException)
        {
            return false;
        }
    }

    private static IHubClients Clients(IServiceProvider sp, HubKind hub, out IGroupManager groups)
    {
        switch (hub)
        {
            case HubKind.Vault: { var h = sp.GetRequiredService<IHubContext<VaultHub>>(); groups = h.Groups; return h.Clients; }
            case HubKind.Sync: { var h = sp.GetRequiredService<IHubContext<SyncHub>>(); groups = h.Groups; return h.Clients; }
            case HubKind.Room: { var h = sp.GetRequiredService<IHubContext<DocumentRoomHub>>(); groups = h.Groups; return h.Clients; }
            default: { var h = sp.GetRequiredService<IHubContext<EdgeSyncHub>>(); groups = h.Groups; return h.Clients; }
        }
    }
}
