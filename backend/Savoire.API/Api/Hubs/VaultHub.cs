// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// VaultHub — Hub SignalR à /hubs/vault.
// see ADR-001

using System.Security.Claims;
using MediatR;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.SignalR;
using Savoire.Application.Sync.Common;
using Savoire.Application.Common;
using Savoire.Application.Documents.CreateDocument;
using Savoire.Application.Documents.DeleteDocument;
using Savoire.Application.Documents.ListDocuments;
using Savoire.Application.Documents.RenameDocument;
using Savoire.Application.Metadata.IndexDocumentContent;
using Savoire.Domain.Exceptions;

namespace Savoire.Server.Hubs;

[Authorize]
public sealed class VaultHub(
    IMediator         mediator,
    ILogger<VaultHub> logger,
    IndexOpSequencer  sequencer) : Hub
{
    // ── Client → Server ───────────────────────────────────────────────────────

    /// <summary>Rejoint le groupe du vault et reçoit la liste courante de ses documents.</summary>
    public async Task JoinVault(string vaultId)
    {
        await Groups.AddToGroupAsync(Context.ConnectionId, vaultId);

        string callerId = GetCallerId();
        IReadOnlyList<DocumentDto> docs = await mediator.Send(
            new ListDocumentsQuery(callerId, vaultId, null, false));

        IEnumerable<VaultSnapshotItem> items = docs
            .Select(d => new VaultSnapshotItem(d.Id, d.Path, d.Title, d.UpdatedAt));

        await Clients.Caller.SendAsync("VaultSnapshot", items);

        logger.LogInformation(
            "Client {ConnectionId} a rejoint le vault {VaultId} — {Count} document(s)",
            Context.ConnectionId, vaultId, docs.Count);
    }

    /// <summary>
    /// Crée un document via la couche Application (MediatR).
    /// Le broadcast DocumentCreated est déclenché par DocumentCreatedNotification.
    /// </summary>
    public async Task<VaultSnapshotItem> CreateDocument(string vaultId, string path, string? title)
    {
        string callerId = GetCallerId();
        try
        {
            DocumentDto doc = await mediator.Send(
                new CreateDocumentCommand(callerId, vaultId, path, null));

            return new VaultSnapshotItem(doc.Id, doc.Path, doc.Title, doc.UpdatedAt);
        }
        catch (PathConflictException ex)
        {
            // 409 prefix: matched by VaultClient._isConflictError() for idempotent handling.
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
            logger.LogError(
                ex,
                "CreateDocument failed for caller={CallerId} vault={VaultId} path={Path}",
                callerId,
                vaultId,
                path);

            // Keep a stable prefix for the UI while surfacing a useful detail.
            throw new HubException($"500: CreateDocument failed: {ex.Message}");
        }
    }

    /// <summary>Renomme un document via MediatR. Broadcast déclenché par DocumentRenamedNotification.</summary>
    public async Task RenameDocument(string documentId, string newPath)
    {
        string callerId = GetCallerId();

        // Récupère le vaultId depuis l'ID du document (via ListDocuments non — via GetById)
        DocumentDto doc = await mediator.Send(
            new RenameDocumentCommand(callerId, "__resolve__", documentId, newPath));

        logger.LogInformation(
            "Document {DocumentId} renommé → {NewPath}", documentId, newPath);

        _ = doc; // résultat utilisé par le handler pour notifier via IPublisher
    }

    /// <summary>Supprime (soft-delete) un document via MediatR. Broadcast déclenché par DocumentDeletedNotification.</summary>
    public async Task DeleteDocument(string documentId)
    {
        string callerId = GetCallerId();
        await mediator.Send(new DeleteDocumentCommand(callerId, "__resolve__", documentId));
    }

    // ── Index ops ─────────────────────────────────────────────────────────────

    /// <summary>
    /// Reçoit une op d'index d'un client, lui assigne un seq et la broadcast aux autres
    /// membres du groupe vault.
    /// </summary>
    public async Task<long> PushIndexOp(PushIndexOpDto dto)
    {
        long seq = sequencer.Next();

        await mediator.Send(new IndexDocumentContentCommand(
            dto.DocId, dto.VaultId, dto.MarkdownContent));

        var evt = new IndexOpAppliedEvent(seq, dto.DocId, dto.Path, dto.MarkdownContent);

        // Broadcast aux autres membres du groupe (pas à l'émetteur)
        await Clients.OthersInGroup(dto.VaultId).SendAsync("IndexOpApplied", evt);

        logger.LogDebug(
            "IndexOp seq={Seq} docId={DocId} path={Path} vault={VaultId}",
            seq, dto.DocId, dto.Path, dto.VaultId);

        return seq;
    }

    // ── Déconnexion ───────────────────────────────────────────────────────────

    public override Task OnDisconnectedAsync(Exception? exception)
    {
        logger.LogInformation("Client déconnecté de VaultHub: {ConnectionId}", Context.ConnectionId);
        return base.OnDisconnectedAsync(exception);
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    private string GetCallerId() =>
        Context.User?.FindFirstValue("sub")
        ?? throw new HubException("Non authentifié.");
}
