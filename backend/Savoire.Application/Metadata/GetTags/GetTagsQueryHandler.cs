// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
using MediatR;
using Savoire.Domain.Repositories;

namespace Savoire.Application.Metadata.GetTags;

public class GetTagsQueryHandler(IDocumentMetaRepository metas)
    : IRequestHandler<GetTagsQuery, IReadOnlyList<string>>
{
    public async Task<IReadOnlyList<string>> Handle(GetTagsQuery query, CancellationToken ct)
    {
        var allMeta = await metas.ListByVaultAsync(query.VaultId, includeDerived: false, ct);
        var tags = allMeta
            .SelectMany(m => m.Tags)
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .OrderBy(t => t)
            .ToList();
        return tags;
    }
}
