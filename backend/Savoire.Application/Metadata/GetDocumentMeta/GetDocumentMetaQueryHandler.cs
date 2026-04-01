// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
using MediatR;
using Savoire.Application.Common;
using Savoire.Domain.Repositories;

namespace Savoire.Application.Metadata.GetDocumentMeta;

public class GetDocumentMetaQueryHandler(IDocumentMetaRepository metas)
    : IRequestHandler<GetDocumentMetaQuery, DocumentMetaDto?>
{
    public async Task<DocumentMetaDto?> Handle(GetDocumentMetaQuery query, CancellationToken ct)
    {
        var meta = await metas.GetByDocumentIdAsync(query.DocId, ct);
        if (meta is null) return null;

        return new DocumentMetaDto(
            meta.DocumentId,
            meta.ContentType,
            meta.DerivedFrom,
            meta.DerivedBy,
            meta.Tags,
            meta.Frontmatter,
            meta.IndexedAt);
    }
}
