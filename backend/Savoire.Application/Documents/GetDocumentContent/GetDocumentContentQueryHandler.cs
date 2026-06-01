// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
using MediatR;
using Savoire.Application.Abstractions;
using Savoire.Application.Sharing;
using Savoire.Domain.Repositories;

namespace Savoire.Application.Documents.GetDocumentContent;

public sealed class GetDocumentContentQueryHandler(
    IShareLinkRepository shareLinks,
    IContentStore        contentStore)
    : IRequestHandler<GetDocumentContentQuery, Stream>
{
    public async Task<Stream> Handle(GetDocumentContentQuery q, CancellationToken ct)
    {
        if (ShareLinkGuard.IsShareLinkCaller(q.CallerId) || ShareLinkGuard.IsViewCaller(q.CallerId))
            await ShareLinkGuard.RequireDocumentReadAsync(q.CallerId, q.VaultId, q.DocId, shareLinks, ct);

        Stream? stream = await contentStore.ReadDocumentAsync(q.VaultId, q.DocId, ct);
        return stream ?? new MemoryStream();
    }
}
