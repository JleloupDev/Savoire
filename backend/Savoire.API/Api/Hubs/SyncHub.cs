// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// SyncHub — Hub SignalR principal à /hubs/sync.
// see ADR-001

using MediatR;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.SignalR;
using Savoire.Application.Sync.HubPushOperation;
using Savoire.Application.Sync.HubSnapshotDocument;
using Savoire.Application.Sync.JoinDocument;

namespace Savoire.Server.Hubs;

[Authorize]
public class SyncHub(IMediator mediator, ILogger<SyncHub> logger) : Hub
{
    // ── Méthodes appelées par le client ────────────────────────────────────────

    public async Task JoinVault(string vaultId)
    {
        await Groups.AddToGroupAsync(Context.ConnectionId, $"vault:{vaultId}");
        logger.LogInformation("Client {Id} a rejoint le vault {VaultId}", Context.ConnectionId, vaultId);
        await Clients.Caller.SendAsync("VaultJoined", vaultId);
    }

    public async Task LeaveVault(string vaultId)
        => await Groups.RemoveFromGroupAsync(Context.ConnectionId, $"vault:{vaultId}");

    public async Task JoinDocument(string vaultId, string docId)
    {
        string callerId = GetCallerId();
        string[] ops = await mediator.Send(new JoinDocumentQuery(callerId, vaultId, docId));

        await Groups.AddToGroupAsync(Context.ConnectionId, $"doc:{docId}");
        await Clients.Caller.SendAsync("InitDocument", docId, ops);

        logger.LogInformation(
            "Client {Id} a rejoint le document {DocId} — {Count} op(s)",
            Context.ConnectionId, docId, ops.Length);
    }

    public async Task LeaveDocument(string vaultId, string docId)
        => await Groups.RemoveFromGroupAsync(Context.ConnectionId, $"doc:{docId}");

    /// <summary>Pousse une opération CRDT (update Yjs encodé en base64).</summary>
    public async Task PushOperation(string vaultId, string docId, string clientId, string opBase64)
    {
        byte[] opBytes;
        try { opBytes = Convert.FromBase64String(opBase64); }
        catch (FormatException ex)
        {
            logger.LogWarning(ex, "opBase64 invalide reçu de {Id}", Context.ConnectionId);
            return;
        }

        await mediator.Send(new HubPushOperationCommand(GetCallerId(), vaultId, docId, clientId, opBytes));

        logger.LogDebug(
            "Op reçue de {Id} pour {DocId} — {Size} octets",
            Context.ConnectionId, docId, opBytes.Length);

        await Clients.OthersInGroup($"doc:{docId}")
            .SendAsync("ReceiveOperation", docId, clientId, opBase64);
    }

    /// <summary>
    /// Relaie une mise à jour d'awareness Yjs (position curseur, info utilisateur).
    /// </summary>
    public async Task UpdateAwareness(string vaultId, string docId, string awarenessBase64)
    {
        await Clients.OthersInGroup($"doc:{docId}")
            .SendAsync("AwarenessUpdated", docId, awarenessBase64);
    }

    /// <summary>
    /// Remplace l'historique d'opérations par un snapshot Yjs compact.
    /// Appelé automatiquement par le premier client qui reçoit trop d'ops dans InitDocument.
    /// </summary>
    public async Task SnapshotDocument(string vaultId, string docId, string snapshotBase64)
    {
        byte[] snapshotBytes;
        try { snapshotBytes = Convert.FromBase64String(snapshotBase64); }
        catch (FormatException ex)
        {
            logger.LogWarning(ex, "SnapshotDocument: base64 invalide pour {DocId}", docId);
            return;
        }
        await mediator.Send(new HubSnapshotDocumentCommand(GetCallerId(), vaultId, docId, snapshotBytes));
        logger.LogInformation("Document {DocId} compacté par {ConnectionId}", docId, Context.ConnectionId);
    }

    /// <summary>Met à jour la position du curseur visible aux collaborateurs.</summary>
    public async Task UpdatePresence(string vaultId, string docId, int cursorPosition)
    {
        string userId = GetCallerId();
        await Clients.OthersInGroup($"doc:{docId}")
            .SendAsync("PresenceUpdated", docId, userId, userId, cursorPosition);
    }

    public override Task OnDisconnectedAsync(Exception? exception)
    {
        logger.LogInformation("Client déconnecté: {Id}", Context.ConnectionId);
        return base.OnDisconnectedAsync(exception);
    }

    private string GetCallerId()
        => Context.User?.FindFirst("sub")?.Value
        ?? Context.GetHttpContext()?.Request.Query["userId"].FirstOrDefault()
        ?? Context.ConnectionId;
}
