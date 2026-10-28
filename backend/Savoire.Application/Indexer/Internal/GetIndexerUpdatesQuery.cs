// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// GET /internal/indexer/vaults/{vaultId}/tree
// GET /internal/indexer/vaults/{vaultId}/documents/{docId}
//
// Le journal Yjs (apres compaction eventuelle) de l'arborescence d'un vault
// ou d'un document. Le pair le rejoue dans un Y.Doc avec le code des clients.
// Rien pour un vault qui n'est pas servi par le pair gere (reglage none ou
// organization) : le pair gere ne lit que ce qu'on lui confie.

using MediatR;
using Savoire.Domain.Aggregates;
using Savoire.Domain.Enums;
using Savoire.Domain.Repositories;

namespace Savoire.Application.Indexer.Internal;

/// <summary>Null : vault inconnu ou non servi par le pair gere (404).</summary>
public sealed record GetIndexerTreeQuery(string VaultId) : IRequest<IndexerUpdatesDto?>;

/// <summary>Null : document non inscrit dans ce vault, ou vault non servi par le pair gere (404).</summary>
public sealed record GetIndexerDocumentQuery(string VaultId, string DocId) : IRequest<IndexerUpdatesDto?>;

public sealed class GetIndexerTreeQueryHandler(
    IVaultRepository               vaults,
    IVaultIndexerSettingRepository settings,
    ICrdtOpRepository              ops) : IRequestHandler<GetIndexerTreeQuery, IndexerUpdatesDto?>
{
    public async Task<IndexerUpdatesDto?> Handle(GetIndexerTreeQuery q, CancellationToken ct)
    {
        if (await vaults.GetByIdAsync(q.VaultId, ct) is null) return null;
        if ((await settings.GetAsync(q.VaultId, ct)).Mode != IndexerMode.Managed) return null;
        IReadOnlyList<Operation> history = await ops.GetAllAsync(CrdtResourceType.Vault, $"vault:{q.VaultId}", ct);
        return new IndexerUpdatesDto([.. history.Select(o => Convert.ToBase64String(o.OpBytes))], IndexerUpdateFormats.Yjs);
    }
}

public sealed class GetIndexerDocumentQueryHandler(
    IVaultDocumentRepository       vaultDocuments,
    IVaultIndexerSettingRepository settings,
    ICrdtOpRepository              ops) : IRequestHandler<GetIndexerDocumentQuery, IndexerUpdatesDto?>
{
    public async Task<IndexerUpdatesDto?> Handle(GetIndexerDocumentQuery q, CancellationToken ct)
    {
        if (await vaultDocuments.GetVaultIdAsync(q.DocId, ct) != q.VaultId) return null;
        if ((await settings.GetAsync(q.VaultId, ct)).Mode != IndexerMode.Managed) return null;

        IReadOnlyList<Operation> history = await ops.GetAllAsync(CrdtResourceType.Document, q.DocId, ct);
        if (history.Count > 0)
            return new IndexerUpdatesDto([.. history.Select(o => Convert.ToBase64String(o.OpBytes))], IndexerUpdateFormats.Yjs);

        // Document « snapshot » (room : tableau...) : son dernier etat JSON.
        IReadOnlyList<Operation> room = await ops.GetAllAsync(CrdtResourceType.Room, q.DocId, ct);
        if (room.Count > 0)
            return new IndexerUpdatesDto([Convert.ToBase64String(room[^1].OpBytes)], IndexerUpdateFormats.Json);

        // Inscrit mais encore vide.
        return new IndexerUpdatesDto([], IndexerUpdateFormats.Yjs);
    }
}
