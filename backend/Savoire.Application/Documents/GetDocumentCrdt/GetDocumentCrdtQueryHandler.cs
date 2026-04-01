// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
using MediatR;
using Savoire.Application.Abstractions;
using Savoire.Domain.Aggregates;
using Savoire.Domain.Exceptions;
using Savoire.Domain.Repositories;

namespace Savoire.Application.Documents.GetDocumentCrdt;

public class GetDocumentCrdtQueryHandler(
    IDocumentRepository documents,
    IContentStore       contentStore)
    : IRequestHandler<GetDocumentCrdtQuery, Stream>
{
    public async Task<Stream> Handle(GetDocumentCrdtQuery q, CancellationToken ct)
    {
        // Access check delegated to VaultAccessBehavior (RequiredAccess = Read).
        Document? doc = await documents.GetByIdAsync(q.DocId, ct);
        if (doc is null || doc.VaultId != q.VaultId) throw new DocumentNotFoundException(q.DocId);

        Stream? stream = await contentStore.ReadCrdtAsync(q.VaultId, q.DocId, ct);
        return stream ?? new MemoryStream();
    }
}
