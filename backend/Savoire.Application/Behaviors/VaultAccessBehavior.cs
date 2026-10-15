// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
using MediatR;
using Savoire.Application.Common;
using Savoire.Application.Sharing;
using Savoire.Domain.Exceptions;
using Savoire.Domain.Repositories;

namespace Savoire.Application.Behaviors;

/// <summary>
/// MediatR pipeline — automatically checks vault access for every
/// command/query implementing <see cref="IRequiresVaultAccess"/> or
/// <see cref="IRequiresDocumentAccess"/>.
///
/// ShareLink (share:…) and ViewGrant (view:…) callers are checked too, against
/// the scope of their link or grant (<see cref="ShareLinkGuard"/>). They used to
/// be skipped here on the assumption that each handler checked them; almost
/// none did, so a link to ONE document opened every document of the server.
/// </summary>
public class VaultAccessBehavior<TRequest, TResponse>(
    IVaultAccessGuard    guard,
    IShareLinkRepository shareLinks)
    : IPipelineBehavior<TRequest, TResponse>
    where TRequest : notnull
{
    public async Task<TResponse> Handle(
        TRequest request,
        RequestHandlerDelegate<TResponse> next,
        CancellationToken ct)
    {
        if (request is IRequiresVaultAccess req)
            await CheckVaultAsync(req, ct);
        else if (request is IRequiresDocumentAccess docReq)
            await CheckDocumentAsync(docReq, ct);

        return await next(ct);
    }

    private async Task CheckVaultAsync(IRequiresVaultAccess req, CancellationToken ct)
    {
        if (IsLinkCaller(req.CallerId))
        {
            switch (req.RequiredAccess)
            {
                case VaultAccessLevel.Write:
                    await ShareLinkGuard.RequireVaultWriteAsync(req.CallerId, req.VaultId, shareLinks, ct);
                    return;
                case VaultAccessLevel.Admin:
                    throw new AccessDeniedException("Un lien de partage ne donne jamais l'administration d'un vault.");
                default:
                    await ShareLinkGuard.RequireVaultReadAsync(req.CallerId, req.VaultId, shareLinks, ct);
                    return;
            }
        }

        if (req.RequiredAccess == VaultAccessLevel.Write)
            await guard.RequireWriteAsync(req.CallerId, req.VaultId, ct);
        else if (req.RequiredAccess == VaultAccessLevel.Admin)
            await guard.RequireAdminAsync(req.CallerId, req.VaultId, ct);
        else
            await guard.RequireReadAsync(req.CallerId, req.VaultId, ct);
    }

    private async Task CheckDocumentAsync(IRequiresDocumentAccess req, CancellationToken ct)
    {
        if (IsLinkCaller(req.CallerId))
        {
            if (req.RequiredAccess == VaultAccessLevel.Write)
                await ShareLinkGuard.RequireDocumentWriteAsync(req.CallerId, req.VaultId, req.DocId, shareLinks, ct);
            else
                await ShareLinkGuard.RequireDocumentReadAsync(req.CallerId, req.VaultId, req.DocId, shareLinks, ct);
            return;
        }

        if (req.RequiredAccess == VaultAccessLevel.Write)
            await guard.RequireDocumentWriteAsync(req.CallerId, req.VaultId, req.DocId, ct);
        else
            await guard.RequireDocumentReadAsync(req.CallerId, req.VaultId, req.DocId, ct);
    }

    private static bool IsLinkCaller(string callerId) =>
        ShareLinkGuard.IsShareLinkCaller(callerId) || ShareLinkGuard.IsViewCaller(callerId);
}
