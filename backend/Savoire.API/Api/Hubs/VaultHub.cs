// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// VaultHub - Hub SignalR a /hubs/vault.
// see ADR-001

using System.Security.Claims;
using MediatR;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.SignalR;
using Savoire.Application.Sync.Common;
using Savoire.Application.Documents.SyncDocumentTitle;
using Savoire.Application.Sync.JoinVault;
using Savoire.Application.Sync.PushVaultOperation;
using Savoire.Application.Sync.SnapshotVault;
using Savoire.Application.Common;
using Savoire.Application.Documents.CreateDocument;
using Savoire.Application.Documents.DeleteDocument;
using Savoire.Application.Documents.RenameDocument;
using Savoire.Domain.Exceptions;

namespace Savoire.Server.Hubs;

[Authorize]
public sealed class VaultHub(
    IMediator         mediator,
    ILogger<VaultHub> logger,
    IndexOpSequencer  sequencer) : Hub
{
    // ── Vault CRDT sync ───────────────────────────────────────────────────────

    /// <summary>
    /// Joins the vault group and receives the current Yjs vault directory state
    /// as an array of base64-encoded ops (same pattern as JoinDocument/InitDocument).
    /// </summary>
    public async Task JoinVault(string vaultId)
    {
        await Groups.AddToGroupAsync(Context.ConnectionId, vaultId);

        JoinVaultResult result = await mediator.Send(new JoinVaultQuery(GetCallerId(), vaultId));

        await Clients.Caller.SendAsync("InitVault", vaultId, result.Ops);

        logger.LogInformation(
            "Client {ConnectionId} joined vault {VaultId} - {Count} vault op(s)",
            Context.ConnectionId, vaultId, result.Ops.Length);
    }

    /// <summary>Relays a Yjs vault directory update to other vault group members.</summary>
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

    /// <summary>
    /// Compacts the vault op log to a single Yjs snapshot.
    /// Called automatically by the first client that receives too many ops in InitVault.
    /// </summary>
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

    // ── Document CRUD (invoked by client, results propagated via CRDT ops) ────

    public async Task<VaultDocumentItem> CreateDocument(string vaultId, string path, string? title)
    {
        string callerId = GetCallerId();
        try
        {
            DocumentDto doc = await mediator.Send(
                new CreateDocumentCommand(callerId, vaultId, path, null));

            return new VaultDocumentItem(doc.Id, doc.Path);
        }
        catch (PathConflictException ex)
        {
            throw new HubException($"409: {ex.Message}");
        }
        catch (AccessDeniedException ex)
        {
            throw new HubException($"403: {ex.Message}");
        }
        catch (VaultNotFoundException ex)
        {
            throw new HubException($"404: {ex.Message}");
        }
        catch (Exception ex)
        {
            logger.LogError(ex, "CreateDocument failed vault={VaultId} path={Path}", vaultId, path);
            throw new HubException($"500: CreateDocument failed: {ex.Message}");
        }
    }

    public async Task RenameDocument(string documentId, string newPath)
    {
        string callerId = GetCallerId();
        await mediator.Send(new RenameDocumentCommand(callerId, "__resolve__", documentId, newPath));
    }

    public async Task DeleteDocument(string documentId)
    {
        string callerId = GetCallerId();
        await mediator.Send(new DeleteDocumentCommand(callerId, "__resolve__", documentId));
    }

    // ── Index ops ─────────────────────────────────────────────────────────────

    public async Task<long> PushIndexOp(PushIndexOpDto dto)
    {
        long seq = sequencer.Next();

        await mediator.Send(new SyncDocumentTitleCommand(dto.DocId, dto.MarkdownContent));

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
