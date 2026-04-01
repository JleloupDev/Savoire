// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
using MediatR;
using Savoire.Application.Common;
using Savoire.Domain.Repositories;

namespace Savoire.Application.Metadata.GetVaultLinks;

public class GetVaultLinksQueryHandler(IDocLinkRepository links)
    : IRequestHandler<GetVaultLinksQuery, IReadOnlyList<VaultLinkDto>>
{
    public async Task<IReadOnlyList<VaultLinkDto>> Handle(GetVaultLinksQuery query, CancellationToken ct)
    {
        var projections = await links.GetAllByVaultAsync(query.VaultId, ct);
        return projections
            .Select(p => new VaultLinkDto(p.SourceId, p.SourcePath, p.TargetId, p.TargetPath, p.LinkType))
            .ToList();
    }
}
