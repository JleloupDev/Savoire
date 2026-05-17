// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
using MediatR;
using Microsoft.Extensions.Logging;
using Savoire.Application.Common;
using Savoire.Application.Documents.ListDocuments;
using Savoire.Application.Sharing;
using Savoire.Domain.Aggregates;
using Savoire.Domain.Enums;
using Savoire.Domain.Exceptions;
using Savoire.Domain.Interfaces;
using Savoire.Domain.Repositories;

namespace Savoire.Application.ViewGrants.CreateViewGrant;

public sealed class CreateViewGrantCommandHandler(
    IVaultRepository vaults,
    IDocumentRepository documents,
    IShareLinkRepository shareLinks,
    ITokenService tokenService,
    ILogger<CreateViewGrantCommandHandler> logger)
    : IRequestHandler<CreateViewGrantCommand, ViewGrantDto>
{
    public async Task<ViewGrantDto> Handle(CreateViewGrantCommand cmd, CancellationToken ct)
    {
        string permission = NormalizePermission(cmd.RequestedPermission);
        Document doc = await ResolveDocumentAsync(cmd, documents, ct);
        logger.LogInformation(
            "CreateViewGrant start caller={Caller} hasShareToken={HasShareToken} doc={DocId} vault={VaultId} permission={Permission}",
            cmd.CallerId,
            !string.IsNullOrWhiteSpace(cmd.ShareToken),
            doc.Id,
            doc.VaultId,
            permission);

        // ── Authorization ─────────────────────────────────────────────────────
        // 1) Explicit share token in request (public AccessShareLink page flow)
        // 2) Existing scoped share caller (Authorization bearer from AccessShareLink)
        // 3) Regular authenticated app user
        string? userIdForPresence = cmd.CallerId;

        if (!string.IsNullOrWhiteSpace(cmd.ShareToken))
        {
            logger.LogInformation("CreateViewGrant auth branch=share-token");
            ShareLink? link = await shareLinks.GetByTokenAsync(cmd.ShareToken!, ct);
            if (link is null || !link.IsValid())
            {
                logger.LogWarning("CreateViewGrant denied: invalid/expired share token");
                throw new AccessDeniedException("Lien de partage invalide ou expiré.");
            }
            EnsureLinkCanAccessDocument(link, doc, permission);
            userIdForPresence = $"share:{link.Id}";
        }
        else if (!string.IsNullOrWhiteSpace(cmd.CallerId) && ShareLinkGuard.IsViewCaller(cmd.CallerId))
        {
            logger.LogInformation("CreateViewGrant auth branch=view-caller");
            // Internal iframe chaining: caller is already a scoped view token.
            // Re-check requested access against the same vault/doc scope.
            if (permission == "write")
                await ShareLinkGuard.RequireDocumentWriteAsync(cmd.CallerId!, doc.VaultId, doc.Id, shareLinks, ct);
            else
                await ShareLinkGuard.RequireDocumentReadAsync(cmd.CallerId!, doc.VaultId, doc.Id, shareLinks, ct);
        }
        else if (!string.IsNullOrWhiteSpace(cmd.CallerId) && ShareLinkGuard.IsShareLinkCaller(cmd.CallerId))
        {
            logger.LogInformation("CreateViewGrant auth branch=share-caller");
            if (permission == "write")
                await ShareLinkGuard.RequireDocumentWriteAsync(cmd.CallerId!, doc.VaultId, doc.Id, shareLinks, ct);
            else
                await ShareLinkGuard.RequireDocumentReadAsync(cmd.CallerId!, doc.VaultId, doc.Id, shareLinks, ct);
        }
        else
        {
            logger.LogInformation("CreateViewGrant auth branch=app-user");
            if (string.IsNullOrWhiteSpace(cmd.CallerId))
            {
                logger.LogWarning("CreateViewGrant denied: missing caller id");
                throw new AccessDeniedException("Authentification requise.");
            }

            if (permission == "write")
                await ListDocumentsQueryHandler.RequireWriteAccessAsync(cmd.CallerId!, doc.VaultId, vaults, ct);
            else
                await ListDocumentsQueryHandler.RequireAccessAsync(cmd.CallerId!, doc.VaultId, vaults, ct);
        }

        DateTime grantExpiresAt = DateTime.UtcNow.AddMinutes(2);
        var payload = new ViewGrantPayload(
            doc.VaultId,
            doc.Id,
            doc.Path,
            permission,
            userIdForPresence,
            grantExpiresAt
        );
        string grantToken = tokenService.GenerateViewGrantToken(payload);
        logger.LogInformation("CreateViewGrant success doc={DocId} permission={Permission}", doc.Id, permission);

        return new ViewGrantDto(
            grantToken,
            doc.VaultId,
            doc.Id,
            doc.Path,
            permission,
            grantExpiresAt
        );
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

    private static void EnsureLinkCanAccessDocument(ShareLink link, Document doc, string requestedPermission)
    {
        bool allowed = link.ResourceType switch
        {
            ResourceType.Vault    => link.ResourceId == doc.VaultId,
            ResourceType.Document => link.ResourceId == doc.Id,
            _                     => false,
        };
        if (!allowed)
            throw new AccessDeniedException("Lien de partage non valide pour ce document.");
        if (requestedPermission == "write" && !link.AllowsWrite())
            throw new AccessDeniedException("Lien de partage sans permission d'écriture.");
    }

    private static async Task<Document> ResolveDocumentAsync(
        CreateViewGrantCommand cmd,
        IDocumentRepository documents,
        CancellationToken ct)
    {
        if (!string.IsNullOrWhiteSpace(cmd.DocId))
        {
            Document? byId = await documents.GetByIdAsync(cmd.DocId!, ct);
            if (byId is null) throw new DocumentNotFoundException(cmd.DocId!);
            if (!string.IsNullOrWhiteSpace(cmd.VaultId) && byId.VaultId != cmd.VaultId)
                throw new AccessDeniedException("Le document n'appartient pas au vault demandé.");
            return byId;
        }

        if (string.IsNullOrWhiteSpace(cmd.VaultId) || string.IsNullOrWhiteSpace(cmd.Path))
            throw new AccessDeniedException("vaultId + (docId ou path) requis.");

        Document? byPath = await documents.GetByPathAsync(cmd.VaultId!, cmd.Path!, ct);
        byPath ??= await documents.GetByPathAsync(cmd.VaultId!, $"{cmd.Path}.md", ct);
        if (byPath is null) throw new DocumentNotFoundException(cmd.Path!);
        return byPath;
    }
}
