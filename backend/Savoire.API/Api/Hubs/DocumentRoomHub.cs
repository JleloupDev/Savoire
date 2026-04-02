// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// DocumentRoomHub — Hub SignalR format-agnostic à /hubs/room.
//
// see ADR-001
//
// Protocole :
//   Client → Serveur : JoinRoom(vaultId, docId)
//                      PushSnapshot(vaultId, docId, snapshotJson)
//                      UpdatePresence(vaultId, docId, presenceJson)
//                      LeaveRoom(vaultId, docId)
//
//   Serveur → Client : RoomJoined(docId, lastSnapshot?)
//                      SnapshotReceived(docId, fromUserId, snapshotJson)
//                      PresenceUpdated(docId, userId, presenceJson)
//
// In-memory cache: last snapshot returned to any new joiner in the room.

using System.Collections.Concurrent;
using System.Security.Claims;
using MediatR;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.SignalR;
using Savoire.Application.Documents.PutDocumentContent;

namespace Savoire.Server.Hubs;

[Authorize]
public class DocumentRoomHub(
    IMediator mediator,
    ILogger<DocumentRoomHub> logger) : Hub
{
    // In-memory cache — last known snapshot per docId.
    private static readonly ConcurrentDictionary<string, string> LastSnapshots = new();

    // ── Methods called by the client ───────────────────────────────────────────

    public async Task JoinRoom(string vaultId, string docId)
    {
        await Groups.AddToGroupAsync(Context.ConnectionId, RoomGroup(docId));

        LastSnapshots.TryGetValue(docId, out string? snapshot);

        logger.LogInformation(
            "[DocumentRoom] Client {Id} joined room {DocId} — snapshot {Status}",
            Context.ConnectionId, docId, snapshot is null ? "absent" : "present");

        await Clients.Caller.SendAsync("RoomJoined", docId, snapshot);
    }

    public async Task LeaveRoom(string vaultId, string docId)
        => await Groups.RemoveFromGroupAsync(Context.ConnectionId, RoomGroup(docId));

    /// <summary>
    /// Receives a full snapshot, persists it, and broadcasts it to other clients in the room.
    /// </summary>
    public async Task PushSnapshot(string vaultId, string docId, string snapshotJson)
    {
        string userId = GetUserId();

        // Update in-memory cache.
        LastSnapshots[docId] = snapshotJson;

        // Persist via MediatR (same pipeline as PUT /documents/{id}/content).
        try
        {
            await mediator.Send(new PutDocumentContentCommand(userId, vaultId, docId, snapshotJson));
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "[DocumentRoom] Failed to persist snapshot for {DocId}", docId);
            // Persistence failure is non-fatal: the snapshot is broadcast regardless.
        }

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
        string userId = GetUserId();
        await Clients.OthersInGroup(RoomGroup(docId))
            .SendAsync("PresenceUpdated", docId, userId, presenceJson);
    }

    public override Task OnDisconnectedAsync(Exception? exception)
    {
        logger.LogInformation("[DocumentRoom] Client disconnected: {Id}", Context.ConnectionId);
        return base.OnDisconnectedAsync(exception);
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    private static string RoomGroup(string docId) => $"room:{docId}";

    private string GetUserId()
        => Context.User?.FindFirstValue("sub")
           ?? Context.ConnectionId;
}
