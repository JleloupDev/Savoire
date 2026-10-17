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
using Savoire.Application.Sync.Access;
using Savoire.Application.Sync.RegisterDocuments;
using Savoire.Application.Common;

namespace Savoire.Server.Hubs;

// Controle d'acces : chaque methode passe par une requete MediatR controlee
// par VaultAccessBehavior (lecture pour entrer, ecriture pour modifier). Le
// controle a lieu AVANT l'entree dans un groupe de diffusion : sinon, meme
// refuse, l'appelant recevrait deja les mises a jour en direct.
[Authorize]
public sealed class VaultHub(
    IMediator             mediator,
    ILogger<VaultHub>     logger,
    DocumentLockRegistry  locks) : Hub
{
    // ── Vault CRDT sync ───────────────────────────────────────────────────────

    public async Task JoinVault(string vaultId)
    {
        JoinVaultResult result = await mediator.Send(new JoinVaultQuery(GetCallerId(), vaultId));

        await Groups.AddToGroupAsync(Context.ConnectionId, vaultId);

        await Clients.Caller.SendAsync("InitVault", vaultId, result.Ops);

        logger.LogInformation(
            "Client {ConnectionId} joined vault {VaultId} - {Count} vault op(s)",
            Context.ConnectionId, vaultId, result.Ops.Length);
    }

    /// <summary>
    /// Verifie seulement que l'appelant peut encore lire le vault. Le client
    /// l'appelle a la reception de VaultAccessChanged : un refus
    /// (« vault-not-found ») lui dit que le vault est supprime ou que son
    /// acces a ete retire. Ne rend rien, ne renvoie pas l'etat du vault.
    /// </summary>
    public Task CheckVaultAccess(string vaultId) =>
        mediator.Send(new CheckVaultAccessQuery(GetCallerId(), vaultId, VaultAccessLevel.Read));

    public async Task PushVaultOperation(string vaultId, string opBase64)
    {
        byte[] opBytes;
        try { opBytes = Convert.FromBase64String(opBase64); }
        catch (FormatException ex)
        {
            logger.LogWarning(ex, "Invalid vault opBase64 from {Id}", Context.ConnectionId);
            return;
        }

        await mediator.Send(new PushVaultOperationCommand(GetCallerId(), vaultId, opBytes));

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
        await mediator.Send(new SnapshotVaultCommand(GetCallerId(), vaultId, snapshotBytes));
        logger.LogInformation("Vault {VaultId} compacted by {ConnectionId}", vaultId, Context.ConnectionId);
    }

    // ── Registre « document -> vault » ────────────────────────────────────────
    //
    // En mode serveur, creer un document commence par l'inscrire ici : le
    // serveur sait alors a quel vault il appartient, et refuse toute demande
    // qui l'annonce dans un autre vault. Exige le droit d'ecrire dans le vault.

    /// <summary>Inscrit des documents dans le vault. Rend ceux refuses (deja dans un autre vault).</summary>
    public async Task<string[]> RegisterDocuments(string vaultId, string[] docIds)
    {
        IReadOnlyList<string> rejected = await mediator.Send(new RegisterDocumentsCommand(GetCallerId(), vaultId, docIds));
        if (rejected.Count > 0)
            logger.LogWarning("RegisterDocuments {VaultId} : {Count} document(s) deja dans un autre vault", vaultId, rejected.Count);
        return [.. rejected];
    }

    // ── Index partagés ────────────────────────────────────────────────────────
    //
    // Un canal CRDT par namespace. Le serveur ne lit rien : il empile des
    // trames opaques et les rediffuse, exactement comme pour le répertoire de
    // vault et les documents. Remplace PushIndexOp, qui recevait le markdown
    // complet et le séquençait — le serveur y était un relais de contenu.

    public async Task<string[]> JoinIndex(string vaultId, string ns)
    {
        JoinIndexResult result = await mediator.Send(new JoinIndexQuery(GetCallerId(), vaultId, ns));
        await Groups.AddToGroupAsync(Context.ConnectionId, IndexGroup(vaultId, ns));
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

        await mediator.Send(new PushIndexUpdateCommand(GetCallerId(), vaultId, ns, bytes));

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
        // Prendre la main, c'est s'appreter a ecrire : un lecteur ne bloque pas les autres.
        await RequireAsync(vaultId, VaultAccessLevel.Write);
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
    public async Task<DocumentLockDto?> GetLock(string vaultId, string docId)
    {
        await RequireAsync(vaultId, VaultAccessLevel.Read);
        LockHolder? holder = locks.Get(vaultId, docId);
        return holder is null
            ? null
            : new DocumentLockDto(holder.UserId, holder.DisplayName, holder.ConnectionId == Context.ConnectionId);
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
        await RequireAsync(vaultId, VaultAccessLevel.Write);
        LockHolder? holder = locks.Get(vaultId, docId);
        if (holder is null) return;
        await Clients.Client(holder.ConnectionId)
            .SendAsync("LockRequested", vaultId, docId, GetCallerId(), GetCallerName());
    }

    private Task RequireAsync(string vaultId, VaultAccessLevel level) =>
        mediator.Send(new CheckVaultAccessQuery(GetCallerId(), vaultId, level));

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
