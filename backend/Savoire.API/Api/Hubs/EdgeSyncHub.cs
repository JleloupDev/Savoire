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

    /// <summary>vaultId -> connectionId of whoever atomically won the right to
    /// mint the vault's genesis key (see EdgeSyncHub.ClaimOwner). The server
    /// only ever brokers WHO won this race, never the key itself.</summary>
    public ConcurrentDictionary<string, string> Owners { get; } = new();
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

    /// <summary>
    /// Atomically claim the right to mint this vault's genesis key. At most one
    /// caller ever gets `true` for a given vaultId (until the room empties and
    /// a fresh election can happen) — replaces the old "peers().length === 0"
    /// client-side heuristic, which let two peers connecting close together
    /// both self-elect and mint independent, unmergeable keys. The server
    /// arbitrates only WHO won; it never sees the key material itself, same
    /// trust boundary as the presence/relay it already brokers.
    /// </summary>
    public bool ClaimOwner(string vaultId)
        => rooms.Owners.TryAdd(vaultId, Context.ConnectionId);

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
                // Release the claim as soon as the claimed connection itself goes
                // away, even if other (possibly ghost) connections keep the room
                // non-empty — otherwise a dead claim blocks the room forever: no
                // one else can ever mint the genesis key, and no one who is
                // waiting on a grant from that connection will ever get one.
                // Accepted v0 gap: if the claimant dies after granting SOME but
                // not all peers, a fresh claimant re-genesis-ing splits the vault
                // (ungranted peers end up on a different K_vault than the ones
                // already granted) — no client-side reconciliation for this today,
                // same "not persisted, best-effort convergence" trade-off as the
                // rest of the Keyring (see EdgesyncVaultSession doc comment).
                if (rooms.Owners.TryGetValue(vaultId, out var ownerConnId) && ownerConnId == Context.ConnectionId)
                {
                    rooms.Owners.TryRemove(vaultId, out _);
                }
                await Clients.Group(Group(vaultId)).SendAsync("PeerDown", vaultId, Context.ConnectionId);
            }
        }
        logger.LogInformation("EdgeSync: {ConnectionId} disconnected", Context.ConnectionId);
        await base.OnDisconnectedAsync(exception);
    }

    private static string Group(string vaultId) => $"edge:{vaultId}";
}
