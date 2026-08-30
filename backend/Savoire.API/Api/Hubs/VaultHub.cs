// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// VaultHub - Hub SignalR a /hubs/vault.
// see ADR-001

using System.Security.Claims;
using MediatR;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.SignalR;
using Savoire.Application.Sync.Common;
using Savoire.Application.Sync.JoinVault;
using Savoire.Application.Sync.PushVaultOperation;
using Savoire.Application.Sync.SnapshotVault;

namespace Savoire.Server.Hubs;

[Authorize]
public sealed class VaultHub(
    IMediator         mediator,
    ILogger<VaultHub> logger,
    IndexOpSequencer  sequencer) : Hub
{
    // ── Vault CRDT sync ───────────────────────────────────────────────────────

    public async Task JoinVault(string vaultId)
    {
        await Groups.AddToGroupAsync(Context.ConnectionId, vaultId);

        JoinVaultResult result = await mediator.Send(new JoinVaultQuery(GetCallerId(), vaultId));

        await Clients.Caller.SendAsync("InitVault", vaultId, result.Ops);

        logger.LogInformation(
            "Client {ConnectionId} joined vault {VaultId} - {Count} vault op(s)",
            Context.ConnectionId, vaultId, result.Ops.Length);
    }

    public async Task PushVaultOperation(string vaultId, string opBase64)
    {
        byte[] opBytes;
        try { opBytes = Convert.FromBase64String(opBase64); }
        catch (FormatException ex)
        {
            logger.LogWarning(ex, "Invalid vault opBase64 from {Id}", Context.ConnectionId);
            return;
        }

        await mediator.Send(new PushVaultOperationCommand(vaultId, opBytes));

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
        await mediator.Send(new SnapshotVaultCommand(vaultId, snapshotBytes));
        logger.LogInformation("Vault {VaultId} compacted by {ConnectionId}", vaultId, Context.ConnectionId);
    }

    // ── Index ops ─────────────────────────────────────────────────────────────

    public async Task<long> PushIndexOp(PushIndexOpDto dto)
    {
        long seq = sequencer.Next();

        var evt = new IndexOpAppliedEvent(seq, dto.DocId, dto.Path, dto.MarkdownContent);
        await Clients.OthersInGroup(dto.VaultId).SendAsync("IndexOpApplied", evt);

        logger.LogDebug("IndexOp seq={Seq} docId={DocId}", seq, dto.DocId);

        return seq;
    }

    // ── Lifecycle ─────────────────────────────────────────────────────────────

    public override Task OnDisconnectedAsync(Exception? exception)
    {
        logger.LogInformation("Client disconnected from VaultHub: {ConnectionId}", Context.ConnectionId);
        return base.OnDisconnectedAsync(exception);
    }

    private string GetCallerId() =>
        Context.User?.FindFirstValue("sub")
        ?? throw new HubException("Not authenticated.");
}
