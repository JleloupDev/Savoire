// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
using MediatR;
using Savoire.Application.Common;
using Savoire.Domain.Aggregates;
using Savoire.Domain.Enums;
using Savoire.Domain.Exceptions;
using Savoire.Domain.Interfaces;
using Savoire.Domain.Repositories;

namespace Savoire.Application.Sharing.AccessShareLink;

public sealed class AccessShareLinkQueryHandler(
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

        // For a link on a document, resolve vaultId and path so the client
        // can build the content URL and select the right editor without knowing the vault upfront.
        string? vaultId = null;
        string? path    = null;
        if (link.ResourceType == ResourceType.Document)
        {
            var doc = await documents.GetByIdAsync(link.ResourceId, ct);
            vaultId = doc?.VaultId;
            path    = doc?.Path;
        }

        return new ShareLinkAccessDto(
            jwt, link.ResourceType.ToApiString(), link.ResourceId,
            link.Permission.ToApiString(), link.ExpiresAt, vaultId, path);
    }
}
