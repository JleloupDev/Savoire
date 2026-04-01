// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
using MediatR;
using Savoire.Application.Common;
using Savoire.Domain.Repositories;

namespace Savoire.Application.Metadata.ListAllMeta;

public class ListAllMetaQueryHandler(IDocumentMetaRepository metas)
    : IRequestHandler<ListAllMetaQuery, IReadOnlyList<DocumentMetaDto>>
{
    public async Task<IReadOnlyList<DocumentMetaDto>> Handle(ListAllMetaQuery query, CancellationToken ct)
    {
        var all = await metas.ListByVaultAsync(query.VaultId, query.IncludeDerived, ct);

        return all
            .Select(m => new DocumentMetaDto(
                m.DocumentId,
                m.ContentType,
                m.DerivedFrom,
                m.DerivedBy,
                m.Tags,
                m.Frontmatter,
                m.IndexedAt))
            .ToList();
    }
}
