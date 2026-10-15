// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// DocumentRoomHub — Hub SignalR /hubs/room.
//
// Synchronisation des documents « snapshot » (Excalidraw, table, mindmap...) :
// dernier-ecrivain-gagne sur des snapshots JSON complets.
//
//   Client → Serveur : JoinRoom(vaultId, docId)
//                      PushSnapshot(vaultId, docId, snapshotJson)
//                      UpdatePresence(vaultId, docId, presenceJson)
//                      LeaveRoom(vaultId, docId)
//
//   Serveur → Client : RoomJoined(docId, lastSnapshot?)
//                      SnapshotReceived(docId, fromUserId, snapshotJson)
//                      PresenceUpdated(docId, userId, presenceJson)
//
// Controle d'acces : entrer exige le droit de lire le document, ecrire celui
// de le modifier (VaultAccessBehavior, comme les notes CRDT). Le controle a
// lieu AVANT l'entree dans le groupe de diffusion. La presence n'est relayee
// que pour une room ou l'appelant est entre.

using System.Security.Claims;
using MediatR;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.SignalR;
using Savoire.Application.Sync.DocumentRoom;

namespace Savoire.Server.Hubs;

[Authorize]
public class DocumentRoomHub(
    IMediator mediator,
    ILogger<DocumentRoomHub> logger) : Hub
{
    private const string JoinedRoomsKey = "joined-rooms";

    // ── Methods called by the client ───────────────────────────────────────────

    public async Task JoinRoom(string vaultId, string docId)
    {
        string? snapshot = await mediator.Send(new JoinRoomQuery(GetUserId(), vaultId, docId));

        await Groups.AddToGroupAsync(Context.ConnectionId, RoomGroup(docId));
        JoinedRooms().Add(docId);

        logger.LogInformation(
            "[DocumentRoom] Client {Id} joined room {DocId} — snapshot {Status}",
            Context.ConnectionId, docId, snapshot is null ? "absent" : "present");

        await Clients.Caller.SendAsync("RoomJoined", docId, snapshot);
    }

    public async Task LeaveRoom(string vaultId, string docId)
    {
        JoinedRooms().Remove(docId);
        await Groups.RemoveFromGroupAsync(Context.ConnectionId, RoomGroup(docId));
    }

    /// <summary>
    /// Receives a full snapshot, persists it, and broadcasts it to other clients in the room.
    /// Refuse (exception) sans droit d'ecriture : rien n'est persiste ni rediffuse.
    /// </summary>
    public async Task PushSnapshot(string vaultId, string docId, string snapshotJson)
    {
        string userId = GetUserId();
        await mediator.Send(new PushRoomSnapshotCommand(userId, vaultId, docId, snapshotJson));

        logger.LogDebug(
            "[DocumentRoom] Snapshot from {UserId} for {DocId} — {Size} bytes",
            userId, docId, snapshotJson.Length);

        await Clients.OthersInGroup(RoomGroup(docId))
            .SendAsync("SnapshotReceived", docId, userId, snapshotJson);
    }

    /// <summary>
    /// Relays presence (cursor position, color, display name) — ephemeral, not persisted.
    /// </summary>
    public async Task UpdatePresence(string vaultId, string docId, string presenceJson)
    {
        if (!JoinedRooms().Contains(docId)) return;
        await Clients.OthersInGroup(RoomGroup(docId))
            .SendAsync("PresenceUpdated", docId, GetUserId(), presenceJson);
    }

    public override Task OnDisconnectedAsync(Exception? exception)
    {
        logger.LogInformation("[DocumentRoom] Client disconnected: {Id}", Context.ConnectionId);
        return base.OnDisconnectedAsync(exception);
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    private static string RoomGroup(string docId) => $"room:{docId}";

    /// <summary>Rooms ou CETTE connexion est entree (controle passe).</summary>
    private HashSet<string> JoinedRooms()
    {
        if (Context.Items.TryGetValue(JoinedRoomsKey, out object? value) && value is HashSet<string> set) return set;
        var created = new HashSet<string>();
        Context.Items[JoinedRoomsKey] = created;
        return created;
    }

    private string GetUserId()
        => Context.User?.FindFirstValue("sub")
           ?? throw new HubException("Not authenticated.");
}
