// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// SyncHub — Hub SignalR principal à /hubs/sync.
// see ADR-001

using System.Security.Claims;
using MediatR;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.SignalR;
using Savoire.Application.Sync.HubPushOperation;
using Savoire.Application.Sync.HubSnapshotDocument;
using Savoire.Application.Sync.JoinDocument;
using Savoire.Application.Sync.Access;
using Savoire.Application.Common;

namespace Savoire.Server.Hubs;

[Authorize]
public class SyncHub(IMediator mediator, ILogger<SyncHub> logger, HubSubscriptions subscriptions) : Hub
{
    // ── Methods called by the client ──────────────────────────────────────────

    public async Task JoinVault(string vaultId)
    {
        await mediator.Send(new CheckVaultAccessQuery(GetCallerId(), vaultId, VaultAccessLevel.Read));
        await Groups.AddToGroupAsync(Context.ConnectionId, $"vault:{vaultId}");
        subscriptions.Add(HubKind.Sync, Context.ConnectionId, GetCallerId(), vaultId, null, $"vault:{vaultId}");
        logger.LogInformation("Client {Id} joined vault {VaultId}", Context.ConnectionId, vaultId);
        await Clients.Caller.SendAsync("VaultJoined", vaultId);
    }

    public async Task LeaveVault(string vaultId)
    {
        subscriptions.Remove(Context.ConnectionId, $"vault:{vaultId}");
        await Groups.RemoveFromGroupAsync(Context.ConnectionId, $"vault:{vaultId}");
    }

    public async Task JoinDocument(string vaultId, string docId)
    {
        string callerId = GetCallerId();
        JoinDocumentResult result = await mediator.Send(new JoinDocumentQuery(callerId, vaultId, docId));

        await Groups.AddToGroupAsync(Context.ConnectionId, $"doc:{docId}");
        subscriptions.Add(HubKind.Sync, Context.ConnectionId, callerId, vaultId, docId, $"doc:{docId}");
        JoinedDocuments().Add(docId);

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
    {
        JoinedDocuments().Remove(docId);
        subscriptions.Remove(Context.ConnectionId, $"doc:{docId}");
        await Groups.RemoveFromGroupAsync(Context.ConnectionId, $"doc:{docId}");
    }

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

        // L'auteur de la modification, donne par le serveur (jamais par le
        // client) : l'historique des versions l'attribue a la bonne personne.
        // Un lien de partage ou un jeton de vue sans compte : « Invité ».
        await Clients.OthersInGroup($"doc:{docId}")
            .SendAsync("ReceiveOperation", docId, clientId, opBase64, AuthorOf(GetCallerId()));
    }

    /// <summary>Qui modifie : un compte (son nom), ou un invite (lien de partage).</summary>
    public sealed record OperationAuthor(string Id, string Name, bool Guest);

    private OperationAuthor AuthorOf(string callerId)
    {
        if (Savoire.Application.Sharing.ShareLinkGuard.IsShareLinkCaller(callerId)
            || Savoire.Application.Sharing.ShareLinkGuard.IsViewCaller(callerId))
        {
            string? viewer = Context.User?.FindFirstValue("view_user_id");
            return viewer is { Length: > 0 } && !viewer.StartsWith("share:", StringComparison.Ordinal)
                ? new OperationAuthor(viewer, Context.User?.FindFirstValue("display_name") ?? "Invité", false)
                : new OperationAuthor(callerId.StartsWith("share:", StringComparison.Ordinal) ? callerId : viewer ?? callerId, "Invité", true);
        }
        string name = Context.User?.FindFirstValue("display_name") ?? Context.User?.FindFirstValue("email") ?? callerId;
        return new OperationAuthor(callerId, name, false);
    }

    /// <summary>
    /// Relays a Yjs awareness update (cursor position, user info).
    /// </summary>
    public async Task UpdateAwareness(string vaultId, string docId, string awarenessBase64)
    {
        // Relaye seulement pour un document ou l'appelant est entre (controle passe).
        if (!JoinedDocuments().Contains(docId)) return;
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
        if (!JoinedDocuments().Contains(docId)) return;
        string userId = GetCallerId();
        await Clients.OthersInGroup($"doc:{docId}")
            .SendAsync("PresenceUpdated", docId, userId, userId, cursorPosition);
    }

    public override Task OnDisconnectedAsync(Exception? exception)
    {
        subscriptions.Forget(Context.ConnectionId);
        logger.LogInformation("Client disconnected: {Id}", Context.ConnectionId);
        return base.OnDisconnectedAsync(exception);
    }

    /// <summary>Documents ou CETTE connexion est entree (controle passe).</summary>
    private HashSet<string> JoinedDocuments()
    {
        if (Context.Items.TryGetValue("joined-docs", out object? value) && value is HashSet<string> set) return set;
        var created = new HashSet<string>();
        Context.Items["joined-docs"] = created;
        return created;
    }

    private string GetCallerId()
        => Context.User?.FindFirst("sub")?.Value
        ?? Context.GetHttpContext()?.Request.Query["userId"].FirstOrDefault()
        ?? Context.ConnectionId;
}
