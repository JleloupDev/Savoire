// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
using MediatR;
using Savoire.Application.Common;
using Savoire.Application.Sharing;

namespace Savoire.Application.Behaviors;

/// <summary>
/// Pipeline MediatR — vérifie automatiquement l'accès vault pour toute
/// commande/requête implémentant <see cref="IRequiresVaultAccess"/>.
///
/// Les callers de type ShareLink (share:…) ou ViewGrant (view:…) sont
/// exclus : leur vérification se fait au niveau document dans le handler.
/// </summary>
public class VaultAccessBehavior<TRequest, TResponse>(IVaultAccessGuard guard)
    : IPipelineBehavior<TRequest, TResponse>
    where TRequest : IRequest<TResponse>
{
    public async Task<TResponse> Handle(
        TRequest request,
        RequestHandlerDelegate<TResponse> next,
        CancellationToken ct)
    {
        if (request is IRequiresVaultAccess req
            && !ShareLinkGuard.IsShareLinkCaller(req.CallerId)
            && !ShareLinkGuard.IsViewCaller(req.CallerId))
        {
            if (req.RequiredAccess == VaultAccessLevel.Write)
                await guard.RequireWriteAsync(req.CallerId, req.VaultId, ct);
            else
                await guard.RequireReadAsync(req.CallerId, req.VaultId, ct);
        }

        return await next(ct);
    }
}
