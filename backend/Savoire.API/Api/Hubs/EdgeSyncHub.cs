// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// EdgeSyncHub - Hub SignalR a /hubs/edgesync.
//
// Blind relay for the edgesync P2P protocol: the server's only jobs here are
// peer introduction (who is present in a vault room) and addressed forwarding
// of OPAQUE frames between two peers. Frames are end-to-end encrypted and
// signed by the protocol (HELLO / OP / KEY / SYNC); this hub never decodes
// them. Identity guarantee comes from [Authorize]: only authenticated users
// are ever put in relation. Vault-level ACL is the protocol's job (keys),
// not the relay's.

using System.Collections.Concurrent;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.SignalR;

namespace Savoire.Server.Hubs;

/// <summary>Singleton room registry: vaultId -> set of connected peer ids.</summary>
public sealed class EdgeSyncRooms
{
    public ConcurrentDictionary<string, ConcurrentDictionary<string, byte>> Rooms { get; } = new();
    public ConcurrentDictionary<string, ConcurrentDictionary<string, byte>> VaultsByConnection { get; } = new();
}

[Authorize]
public sealed class EdgeSyncHub(
    EdgeSyncRooms         rooms,
    ILogger<EdgeSyncHub>  logger) : Hub
{
    // A relayed frame is one protocol message; 2 MB of base64 is far above any
    // legitimate envelope and protects the relay from memory abuse.
    private const int MaxFrameBase64Length = 2 * 1024 * 1024;

    /// <summary>Enter a vault room. Returns the peer ids already present.</summary>
    public async Task<string[]> Join(string vaultId)
    {
        var room = rooms.Rooms.GetOrAdd(vaultId, _ => new ConcurrentDictionary<string, byte>());
        string[] existing = [.. room.Keys.Where(id => id != Context.ConnectionId)];

        room[Context.ConnectionId] = 1;
        rooms.VaultsByConnection.GetOrAdd(Context.ConnectionId, _ => new ConcurrentDictionary<string, byte>())[vaultId] = 1;

        await Groups.AddToGroupAsync(Context.ConnectionId, Group(vaultId));
        await Clients.OthersInGroup(Group(vaultId)).SendAsync("PeerUp", vaultId, Context.ConnectionId);

        logger.LogInformation("EdgeSync: {ConnectionId} joined {VaultId} ({Count} peer(s) present)",
            Context.ConnectionId, vaultId, existing.Length);
        return existing;
    }

    /// <summary>Forward one opaque frame to one peer of the same vault room.</summary>
    public Task Relay(string vaultId, string toPeer, string frameBase64)
    {
        if (frameBase64.Length > MaxFrameBase64Length) return Task.CompletedTask;
        // Both ends must be members of the room: prevents cross-vault probing.
        if (!rooms.Rooms.TryGetValue(vaultId, out var room)) return Task.CompletedTask;
        if (!room.ContainsKey(Context.ConnectionId) || !room.ContainsKey(toPeer)) return Task.CompletedTask;

        return Clients.Client(toPeer).SendAsync("Frame", vaultId, Context.ConnectionId, frameBase64);
    }

    public override async Task OnDisconnectedAsync(Exception? exception)
    {
        if (rooms.VaultsByConnection.TryRemove(Context.ConnectionId, out var vaults))
        {
            foreach (string vaultId in vaults.Keys)
            {
                if (rooms.Rooms.TryGetValue(vaultId, out var room))
                {
                    room.TryRemove(Context.ConnectionId, out _);
                    if (room.IsEmpty) rooms.Rooms.TryRemove(vaultId, out _);
                }
                await Clients.Group(Group(vaultId)).SendAsync("PeerDown", vaultId, Context.ConnectionId);
            }
        }
        logger.LogInformation("EdgeSync: {ConnectionId} disconnected", Context.ConnectionId);
        await base.OnDisconnectedAsync(exception);
    }

    private static string Group(string vaultId) => $"edge:{vaultId}";
}
