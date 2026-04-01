// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
using MediatR;
using Savoire.Application.Abstractions;
using Savoire.Application.Sharing;
using Savoire.Domain.Aggregates;
using Savoire.Domain.Exceptions;
using Savoire.Domain.Repositories;

namespace Savoire.Application.Documents.GetDocumentContent;

public class GetDocumentContentQueryHandler(
    IDocumentRepository  documents,
    IShareLinkRepository shareLinks,
    IContentStore        contentStore)
    : IRequestHandler<GetDocumentContentQuery, Stream>
{
    public async Task<Stream> Handle(GetDocumentContentQuery q, CancellationToken ct)
    {
        // VaultAccessBehavior gère les callers normaux.
        // ShareLink/View callers sont exclus du behavior — vérification au niveau document ici.
        if (ShareLinkGuard.IsShareLinkCaller(q.CallerId) || ShareLinkGuard.IsViewCaller(q.CallerId))
            await ShareLinkGuard.RequireDocumentReadAsync(q.CallerId, q.VaultId, q.DocId, shareLinks, ct);

        Document? doc = await documents.GetByIdAsync(q.DocId, ct);
        if (doc is null || doc.VaultId != q.VaultId) throw new DocumentNotFoundException(q.DocId);

        Stream? stream = await contentStore.ReadDocumentAsync(q.VaultId, q.DocId, ct);
        return stream ?? new MemoryStream();
    }
}
