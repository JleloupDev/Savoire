// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
using MediatR;
using Microsoft.Extensions.Logging;
using Savoire.Application.Common;
using Savoire.Application.Sharing;
using Savoire.Domain.Aggregates;
using Savoire.Domain.Enums;
using Savoire.Domain.Exceptions;
using Savoire.Domain.Interfaces;
using Savoire.Domain.Repositories;

namespace Savoire.Application.ViewGrants.CreateViewGrant;

public sealed class CreateViewGrantCommandHandler(
    IVaultRepository    vaults,
    IShareLinkRepository shareLinks,
    ITokenService       tokenService,
    ILogger<CreateViewGrantCommandHandler> logger)
    : IRequestHandler<CreateViewGrantCommand, ViewGrantDto>
{
    public async Task<ViewGrantDto> Handle(CreateViewGrantCommand cmd, CancellationToken ct)
    {
        string permission = NormalizePermission(cmd.RequestedPermission);

        // DocId + VaultId must be provided — path-based lookup is not available
        // without a SQL document projection (removed in P2P refactor).
        if (string.IsNullOrWhiteSpace(cmd.DocId) || string.IsNullOrWhiteSpace(cmd.VaultId))
            throw new AccessDeniedException("docId et vaultId sont requis.");

        string docId   = cmd.DocId!;
        string vaultId = cmd.VaultId!;
        string path    = cmd.Path ?? "";

        logger.LogInformation(
            "CreateViewGrant start caller={Caller} doc={DocId} vault={VaultId} permission={Permission}",
            cmd.CallerId, docId, vaultId, permission);

        string? userIdForPresence = cmd.CallerId;

        if (!string.IsNullOrWhiteSpace(cmd.ShareToken))
        {
            logger.LogInformation("CreateViewGrant auth branch=share-token");
            ShareLink? link = await shareLinks.GetByTokenAsync(cmd.ShareToken!, ct);
            if (link is null || !link.IsValid())
                throw new AccessDeniedException("Lien de partage invalide ou expire.");

            EnsureLinkCanAccessDocument(link, vaultId, docId, permission);
            userIdForPresence = $"share:{link.Id}";
        }
        else if (!string.IsNullOrWhiteSpace(cmd.CallerId) && ShareLinkGuard.IsViewCaller(cmd.CallerId))
        {
            logger.LogInformation("CreateViewGrant auth branch=view-caller");
            if (permission == "write")
                await ShareLinkGuard.RequireDocumentWriteAsync(cmd.CallerId!, vaultId, docId, shareLinks, ct);
            else
                await ShareLinkGuard.RequireDocumentReadAsync(cmd.CallerId!, vaultId, docId, shareLinks, ct);
        }
        else if (!string.IsNullOrWhiteSpace(cmd.CallerId) && ShareLinkGuard.IsShareLinkCaller(cmd.CallerId))
        {
            logger.LogInformation("CreateViewGrant auth branch=share-caller");
            if (permission == "write")
                await ShareLinkGuard.RequireDocumentWriteAsync(cmd.CallerId!, vaultId, docId, shareLinks, ct);
            else
                await ShareLinkGuard.RequireDocumentReadAsync(cmd.CallerId!, vaultId, docId, shareLinks, ct);
        }
        else
        {
            logger.LogInformation("CreateViewGrant auth branch=app-user");
            if (string.IsNullOrWhiteSpace(cmd.CallerId))
                throw new AccessDeniedException("Authentification requise.");

            Vault? vault = await vaults.GetByIdAsync(vaultId, ct);
            if (vault is null) throw new VaultNotFoundException(vaultId);
            if (!vault.IsOwner(cmd.CallerId))
            {
                VaultMember? member = await vaults.GetMemberAsync(vaultId, cmd.CallerId, ct);
                if (member is null) throw new AccessDeniedException("Acces refuse.");
                if (permission == "write" && member.Role == VaultRole.Viewer)
                    throw new AccessDeniedException("Permission d'ecriture requise.");
            }
        }

        DateTime grantExpiresAt = DateTime.UtcNow.AddMinutes(2);
        var payload = new ViewGrantPayload(vaultId, docId, path, permission, userIdForPresence, grantExpiresAt);
        string grantToken = tokenService.GenerateViewGrantToken(payload);
        logger.LogInformation("CreateViewGrant success doc={DocId}", docId);

        return new ViewGrantDto(grantToken, vaultId, docId, path, permission, grantExpiresAt);
    }

    private static string NormalizePermission(string? requested)
    {
        string p = (requested ?? "read").Trim().ToLowerInvariant();
        return p switch
        {
            "read"  => "read",
            "write" => "write",
            _       => throw new AccessDeniedException("Permission invalide (read|write)."),
        };
    }

    private static void EnsureLinkCanAccessDocument(
        ShareLink link, string vaultId, string docId, string requestedPermission)
    {
        bool allowed = link.ResourceType switch
        {
            ResourceType.Vault    => link.ResourceId == vaultId,
            ResourceType.Document => link.ResourceId == docId,
            _                     => false,
        };
        if (!allowed)
            throw new AccessDeniedException("Lien de partage non valide pour ce document.");
        if (requestedPermission == "write" && !link.AllowsWrite())
            throw new AccessDeniedException("Lien de partage sans permission d'ecriture.");
    }
}
