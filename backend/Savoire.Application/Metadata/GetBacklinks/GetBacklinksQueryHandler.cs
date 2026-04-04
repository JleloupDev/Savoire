// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
using MediatR;
using Savoire.Application.Common;
using Savoire.Domain.Enums;
using Savoire.Domain.Repositories;

namespace Savoire.Application.Metadata.GetBacklinks;

public class GetBacklinksQueryHandler(
    IDocLinkRepository     links,
    IDocumentRepository    documents)
    : IRequestHandler<GetBacklinksQuery, IReadOnlyList<BacklinkDto>>
{
    public async Task<IReadOnlyList<BacklinkDto>> Handle(GetBacklinksQuery query, CancellationToken ct)
    {
        var backlinks = await links.GetBacklinksAsync(query.DocId, ct);
        var result    = new List<BacklinkDto>();

        foreach (var link in backlinks)
        {
            var doc = await documents.GetByIdAsync(link.SourceId, ct);
            if (doc is null || doc.DeletedAt.HasValue) continue;
            result.Add(new BacklinkDto(doc.Id, doc.Path, doc.Title, link.LinkType.ToApiString()));
        }

        return result;
    }
}
