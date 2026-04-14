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
    // ── Methods called by the client ──────────────────────────────────────────

    public async Task JoinVault(string vaultId)
    {
        await Groups.AddToGroupAsync(Context.ConnectionId, $"vault:{vaultId}");
        logger.LogInformation("Client {Id} joined vault {VaultId}", Context.ConnectionId, vaultId);
        await Clients.Caller.SendAsync("VaultJoined", vaultId);
    }

    public async Task LeaveVault(string vaultId)
        => await Groups.RemoveFromGroupAsync(Context.ConnectionId, $"vault:{vaultId}");

    public async Task JoinDocument(string vaultId, string docId)
    {
        string callerId = GetCallerId();
        JoinDocumentResult result = await mediator.Send(new JoinDocumentQuery(callerId, vaultId, docId));

        await Groups.AddToGroupAsync(Context.ConnectionId, $"doc:{docId}");

        // Non-vault-members with document-level permission subscribe to metadata
        // events (rename, delete, access revoke) via the doc-events group.
        if (!result.CallerIsVaultMember)
            await Groups.AddToGroupAsync(Context.ConnectionId, $"doc-events:{docId}");

        await Clients.Caller.SendAsync("InitDocument", docId, result.Ops);

        logger.LogInformation(
            "Client {Id} joined document {DocId} — {Count} op(s), vaultMember={IsMember}",
            Context.ConnectionId, docId, result.Ops.Length, result.CallerIsVaultMember);
    }

    public async Task LeaveDocument(string vaultId, string docId)
        => await Groups.RemoveFromGroupAsync(Context.ConnectionId, $"doc:{docId}");

    /// <summary>Pushes a CRDT operation (base64-encoded Yjs update).</summary>
    public async Task PushOperation(string vaultId, string docId, string clientId, string opBase64)
    {
        byte[] opBytes;
        try { opBytes = Convert.FromBase64String(opBase64); }
        catch (FormatException ex)
        {
            logger.LogWarning(ex, "Invalid opBase64 received from {Id}", Context.ConnectionId);
            return;
        }

        await mediator.Send(new HubPushOperationCommand(GetCallerId(), vaultId, docId, clientId, opBytes));

        logger.LogDebug(
            "Op received from {Id} for {DocId} — {Size} bytes",
            Context.ConnectionId, docId, opBytes.Length);

        await Clients.OthersInGroup($"doc:{docId}")
            .SendAsync("ReceiveOperation", docId, clientId, opBase64);
    }

    /// <summary>
    /// Relays a Yjs awareness update (cursor position, user info).
    /// </summary>
    public async Task UpdateAwareness(string vaultId, string docId, string awarenessBase64)
    {
        await Clients.OthersInGroup($"doc:{docId}")
            .SendAsync("AwarenessUpdated", docId, awarenessBase64);
    }

    /// <summary>
    /// Replaces the operation history with a compact Yjs snapshot.
    /// Automatically called by the first client that receives too many ops in InitDocument.
    /// </summary>
    public async Task SnapshotDocument(string vaultId, string docId, string snapshotBase64)
    {
        byte[] snapshotBytes;
        try { snapshotBytes = Convert.FromBase64String(snapshotBase64); }
        catch (FormatException ex)
        {
            logger.LogWarning(ex, "SnapshotDocument: invalid base64 for {DocId}", docId);
            return;
        }
        await mediator.Send(new HubSnapshotDocumentCommand(GetCallerId(), vaultId, docId, snapshotBytes));
        logger.LogInformation("Document {DocId} compacté par {ConnectionId}", docId, Context.ConnectionId);
    }

    /// <summary>Updates the cursor position visible to collaborators.</summary>
    public async Task UpdatePresence(string vaultId, string docId, int cursorPosition)
    {
        string userId = GetCallerId();
        await Clients.OthersInGroup($"doc:{docId}")
            .SendAsync("PresenceUpdated", docId, userId, userId, cursorPosition);
    }

    public override Task OnDisconnectedAsync(Exception? exception)
    {
        logger.LogInformation("Client disconnected: {Id}", Context.ConnectionId);
        return base.OnDisconnectedAsync(exception);
    }

    private string GetCallerId()
        => Context.User?.FindFirst("sub")?.Value
        ?? Context.GetHttpContext()?.Request.Query["userId"].FirstOrDefault()
        ?? Context.ConnectionId;
}
