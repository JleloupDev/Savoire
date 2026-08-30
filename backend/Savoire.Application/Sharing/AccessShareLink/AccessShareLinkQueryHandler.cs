// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
using MediatR;
using Savoire.Application.Common;
using Savoire.Domain.Enums;
using Savoire.Domain.Exceptions;
using Savoire.Domain.Interfaces;
using Savoire.Domain.Repositories;

namespace Savoire.Application.Sharing.AccessShareLink;

public sealed class AccessShareLinkQueryHandler(
    IShareLinkRepository shareLinks,
    ITokenService        tokenService)
    : IRequestHandler<AccessShareLinkQuery, ShareLinkAccessDto>
{
    public async Task<ShareLinkAccessDto> Handle(
        AccessShareLinkQuery q, CancellationToken ct)
    {
        var link = await shareLinks.GetByTokenAsync(q.Token, ct);

        if (link is null || !link.IsValid())
            throw new AccessDeniedException("Lien de partage invalide ou expire.");

        string jwt = tokenService.GenerateShareLinkAccessToken(link);

        // vaultId and path are unknown without SQL document projection.
        // TODO(P4): resolve via CRDT vault directory.
        return new ShareLinkAccessDto(
            jwt, link.ResourceType.ToApiString(), link.ResourceId,
            link.Permission.ToApiString(), link.ExpiresAt, null, null);
    }
}
