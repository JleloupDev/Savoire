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
// Cache mémoire : dernier snapshot retourné à tout nouvel arrivant dans la room.

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
    // Cache mémoire — dernier snapshot connu par docId.
    private static readonly ConcurrentDictionary<string, string> LastSnapshots = new();

    // ── Méthodes appelées par le client ────────────────────────────────────────

    public async Task JoinRoom(string vaultId, string docId)
    {
        await Groups.AddToGroupAsync(Context.ConnectionId, RoomGroup(docId));

        LastSnapshots.TryGetValue(docId, out string? snapshot);

        logger.LogInformation(
            "[DocumentRoom] Client {Id} a rejoint la room {DocId} — snapshot {Status}",
            Context.ConnectionId, docId, snapshot is null ? "absent" : "présent");

        await Clients.Caller.SendAsync("RoomJoined", docId, snapshot);
    }

    public async Task LeaveRoom(string vaultId, string docId)
        => await Groups.RemoveFromGroupAsync(Context.ConnectionId, RoomGroup(docId));

    /// <summary>
    /// Reçoit un snapshot complet, le persiste et le diffuse aux autres clients de la room.
    /// </summary>
    public async Task PushSnapshot(string vaultId, string docId, string snapshotJson)
    {
        string userId = GetUserId();

        // Mise à jour du cache mémoire.
        LastSnapshots[docId] = snapshotJson;

        // Persistance via MediatR (même pipeline que PUT /documents/{id}/content).
        try
        {
            await mediator.Send(new PutDocumentContentCommand(userId, vaultId, docId, snapshotJson));
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "[DocumentRoom] Échec persistance snapshot pour {DocId}", docId);
            // Persistence failure is non-fatal: the snapshot is broadcast regardless.
        }

        logger.LogDebug(
            "[DocumentRoom] Snapshot de {UserId} pour {DocId} — {Size} octets",
            userId, docId, snapshotJson.Length);

        await Clients.OthersInGroup(RoomGroup(docId))
            .SendAsync("SnapshotReceived", docId, userId, snapshotJson);
    }

    /// <summary>
    /// Relaie la présence (position curseur, couleur, nom) — éphémère, non persisté.
    /// </summary>
    public async Task UpdatePresence(string vaultId, string docId, string presenceJson)
    {
        string userId = GetUserId();
        await Clients.OthersInGroup(RoomGroup(docId))
            .SendAsync("PresenceUpdated", docId, userId, presenceJson);
    }

    public override Task OnDisconnectedAsync(Exception? exception)
    {
        logger.LogInformation("[DocumentRoom] Client déconnecté: {Id}", Context.ConnectionId);
        return base.OnDisconnectedAsync(exception);
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    private static string RoomGroup(string docId) => $"room:{docId}";

    private string GetUserId()
        => Context.User?.FindFirstValue("sub")
           ?? Context.ConnectionId;
}
