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

using System.Security.Claims;
using System.Text;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.SignalR;
using Savoire.Domain.Aggregates;
using Savoire.Domain.Repositories;

namespace Savoire.Server.Hubs;

[Authorize]
public class DocumentRoomHub(
    ICrdtOpRepository ops,
    ILogger<DocumentRoomHub> logger) : Hub
{
    // ── Methods called by the client ───────────────────────────────────────────

    public async Task JoinRoom(string vaultId, string docId)
    {
        await Groups.AddToGroupAsync(Context.ConnectionId, RoomGroup(docId));

        // The op log holds a single compacted snapshot per room (see PushSnapshot).
        var history = await ops.GetAllAsync(CrdtResourceType.Room, docId);
        string? snapshot = history.Count > 0
            ? Encoding.UTF8.GetString(history[^1].OpBytes)
            : null;

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

        // Persist to the CRDT op log (compacted: one snapshot per room).
        // TODO(perf): CompactAsync does delete-all + insert per push. For busy
        // rooms (excalidraw), replace with a dedicated single-row upsert.
        try
        {
            await ops.CompactAsync(CrdtResourceType.Room, docId, Encoding.UTF8.GetBytes(snapshotJson), force: true);
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
