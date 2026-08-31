// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// VaultHub - Hub SignalR a /hubs/vault.
// see ADR-001

using System.Security.Claims;
using MediatR;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.SignalR;
using Savoire.Application.Sync.JoinVault;
using Savoire.Application.Sync.PushVaultOperation;
using Savoire.Application.Sync.SnapshotVault;
using Savoire.Application.Sync.IndexChannel;
using Savoire.Application.Common;

namespace Savoire.Server.Hubs;

[Authorize]
public sealed class VaultHub(
    IMediator             mediator,
    ILogger<VaultHub>     logger,
    DocumentLockRegistry  locks) : Hub
{
    // ── Vault CRDT sync ───────────────────────────────────────────────────────

    public async Task JoinVault(string vaultId)
    {
        await Groups.AddToGroupAsync(Context.ConnectionId, vaultId);

        JoinVaultResult result = await mediator.Send(new JoinVaultQuery(GetCallerId(), vaultId));

        await Clients.Caller.SendAsync("InitVault", vaultId, result.Ops);

        logger.LogInformation(
            "Client {ConnectionId} joined vault {VaultId} - {Count} vault op(s)",
            Context.ConnectionId, vaultId, result.Ops.Length);
    }

    public async Task PushVaultOperation(string vaultId, string opBase64)
    {
        byte[] opBytes;
        try { opBytes = Convert.FromBase64String(opBase64); }
        catch (FormatException ex)
        {
            logger.LogWarning(ex, "Invalid vault opBase64 from {Id}", Context.ConnectionId);
            return;
        }

        await mediator.Send(new PushVaultOperationCommand(vaultId, opBytes));

        await Clients.OthersInGroup(vaultId)
            .SendAsync("VaultOperationReceived", vaultId, opBase64);
    }

    public async Task SnapshotVault(string vaultId, string snapshotBase64)
    {
        byte[] snapshotBytes;
        try { snapshotBytes = Convert.FromBase64String(snapshotBase64); }
        catch (FormatException ex)
        {
            logger.LogWarning(ex, "SnapshotVault: invalid base64 for {VaultId}", vaultId);
            return;
        }
        await mediator.Send(new SnapshotVaultCommand(vaultId, snapshotBytes));
        logger.LogInformation("Vault {VaultId} compacted by {ConnectionId}", vaultId, Context.ConnectionId);
    }

    // ── Index partagés ────────────────────────────────────────────────────────
    //
    // Un canal CRDT par namespace. Le serveur ne lit rien : il empile des
    // trames opaques et les rediffuse, exactement comme pour le répertoire de
    // vault et les documents. Remplace PushIndexOp, qui recevait le markdown
    // complet et le séquençait — le serveur y était un relais de contenu.

    public async Task<string[]> JoinIndex(string vaultId, string ns)
    {
        await Groups.AddToGroupAsync(Context.ConnectionId, IndexGroup(vaultId, ns));
        JoinIndexResult result = await mediator.Send(new JoinIndexQuery(vaultId, ns));
        logger.LogInformation(
            "Client {ConnectionId} joined index {VaultId}/{Namespace} - {Count} op(s)",
            Context.ConnectionId, vaultId, ns, result.Ops.Length);
        return result.Ops;
    }

    public async Task PushIndexUpdate(string vaultId, string ns, string updateBase64)
    {
        byte[] bytes;
        try { bytes = Convert.FromBase64String(updateBase64); }
        catch (FormatException ex)
        {
            logger.LogWarning(ex, "Invalid index update from {Id}", Context.ConnectionId);
            return;
        }

        await mediator.Send(new PushIndexUpdateCommand(vaultId, ns, bytes));

        await Clients.OthersInGroup(IndexGroup(vaultId, ns))
            .SendAsync("IndexUpdateReceived", vaultId, ns, updateBase64);
    }

    private static string IndexGroup(string vaultId, string ns) => $"idx:{vaultId}:{ns}";

    // ── Verrous d'edition ─────────────────────────────────────────────────────
    //
    // Pour les types de documents qui ne sont pas des CRDT (mindmap, excalidraw
    // aujourd'hui), la synchronisation se fait par snapshots en
    // dernier-ecrivain-gagne : a deux, l'un ecrase l'autre en silence. Un seul
    // redacteur a la fois, donc, et les autres en lecture seule.
    //
    // L'arbitrage est central parce qu'il ne peut pas etre autrement : deux
    // clients qui demandent le verrou au meme instant ne peuvent pas trancher
    // entre eux. TryAcquire est atomique.

    /// <summary>Prend le verrou s'il est libre. Rend le detenteur effectif.</summary>
    public async Task<DocumentLockDto> AcquireLock(string vaultId, string docId)
    {
        var candidate = new LockHolder(GetCallerId(), GetCallerName(), Context.ConnectionId);
        LockHolder holder = locks.TryAcquire(vaultId, docId, candidate);
        bool acquired = holder.ConnectionId == Context.ConnectionId;

        if (acquired)
        {
            await Clients.OthersInGroup(vaultId)
                .SendAsync("LockChanged", vaultId, docId, holder.UserId, holder.DisplayName);
            logger.LogInformation("Lock {VaultId}/{DocId} pris par {User}", vaultId, docId, holder.DisplayName);
        }

        return new DocumentLockDto(holder.UserId, holder.DisplayName, acquired);
    }

    /// <summary>Rend l'etat courant du verrou, sans le prendre.</summary>
    public Task<DocumentLockDto?> GetLock(string vaultId, string docId)
    {
        LockHolder? holder = locks.Get(vaultId, docId);
        return Task.FromResult(holder is null
            ? null
            : new DocumentLockDto(holder.UserId, holder.DisplayName, holder.ConnectionId == Context.ConnectionId));
    }

    public async Task ReleaseLock(string vaultId, string docId)
    {
        if (!locks.Release(vaultId, docId, Context.ConnectionId)) return;
        await Clients.Group(vaultId).SendAsync("LockChanged", vaultId, docId, null, null);
        logger.LogInformation("Lock {VaultId}/{DocId} libere", vaultId, docId);
    }

    /// <summary>
    /// Demande la main au detenteur courant. On ne la prend pas d'autorite :
    /// le detenteur est peut-etre en train d'ecrire. Il recoit la demande et
    /// decide.
    /// </summary>
    public async Task RequestLock(string vaultId, string docId)
    {
        LockHolder? holder = locks.Get(vaultId, docId);
        if (holder is null) return;
        await Clients.Client(holder.ConnectionId)
            .SendAsync("LockRequested", vaultId, docId, GetCallerId(), GetCallerName());
    }

    private string GetCallerName()
        => Context.User?.FindFirstValue("display_name")
        ?? Context.User?.FindFirstValue("email")
        ?? "Quelqu'un";

    // ── Lifecycle ─────────────────────────────────────────────────────────────

    public override async Task OnDisconnectedAsync(Exception? exception)
    {
        // Sans cela, fermer un onglet laisserait le document verrouille pour
        // tout le monde, sans detenteur joignable.
        foreach (string key in locks.ReleaseAllFor(Context.ConnectionId))
        {
            string[] parts = key.Split('/', 2);
            if (parts.Length != 2) continue;
            await Clients.Group(parts[0]).SendAsync("LockChanged", parts[0], parts[1], null, null);
        }
        logger.LogInformation("Client disconnected from VaultHub: {ConnectionId}", Context.ConnectionId);
        await base.OnDisconnectedAsync(exception);
    }

    private string GetCallerId() =>
        Context.User?.FindFirstValue("sub")
        ?? throw new HubException("Not authenticated.");
}
