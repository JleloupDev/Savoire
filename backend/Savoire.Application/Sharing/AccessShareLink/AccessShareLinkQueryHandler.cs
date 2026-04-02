// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
using MediatR;
using Savoire.Application.Common;
using Savoire.Domain.Aggregates;
using Savoire.Domain.Exceptions;
using Savoire.Domain.Interfaces;
using Savoire.Domain.Repositories;

namespace Savoire.Application.Sharing.AccessShareLink;

public class AccessShareLinkQueryHandler(
    IShareLinkRepository shareLinks,
    IDocumentRepository  documents,
    ITokenService        tokenService)
    : IRequestHandler<AccessShareLinkQuery, ShareLinkAccessDto>
{
    public async Task<ShareLinkAccessDto> Handle(
        AccessShareLinkQuery q, CancellationToken ct)
    {
        ShareLink? link = await shareLinks.GetByTokenAsync(q.Token, ct);

        if (link is null || !link.IsValid())
            throw new AccessDeniedException("Lien de partage invalide ou expiré.");

        string jwt = tokenService.GenerateShareLinkAccessToken(link);

        // For a link on a document, resolve the vaultId so the client
        // can build the content URL without knowing the vault upfront.
        string? vaultId = null;
        if (link.ResourceType == "document")
        {
            var doc = await documents.GetByIdAsync(link.ResourceId, ct);
            vaultId = doc?.VaultId;
        }

        return new ShareLinkAccessDto(
            jwt, link.ResourceType, link.ResourceId,
            link.Permission, link.ExpiresAt, vaultId);
    }
}
