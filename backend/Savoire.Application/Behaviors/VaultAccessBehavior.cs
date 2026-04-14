// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
using MediatR;
using Savoire.Application.Common;
using Savoire.Application.Sharing;

namespace Savoire.Application.Behaviors;

/// <summary>
/// MediatR pipeline — automatically checks vault access for every
/// command/query implementing <see cref="IRequiresVaultAccess"/>.
///
/// ShareLink (share:…) or ViewGrant (view:…) callers are excluded:
/// their check is performed at the document level inside the handler.
/// </summary>
public class VaultAccessBehavior<TRequest, TResponse>(IVaultAccessGuard guard)
    : IPipelineBehavior<TRequest, TResponse>
    where TRequest : notnull
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
            else if (req.RequiredAccess == VaultAccessLevel.Admin)
                await guard.RequireAdminAsync(req.CallerId, req.VaultId, ct);
            else
                await guard.RequireReadAsync(req.CallerId, req.VaultId, ct);
        }
        else if (request is IRequiresDocumentAccess docReq
            && !ShareLinkGuard.IsShareLinkCaller(docReq.CallerId)
            && !ShareLinkGuard.IsViewCaller(docReq.CallerId))
        {
            if (docReq.RequiredAccess == VaultAccessLevel.Write)
                await guard.RequireDocumentWriteAsync(docReq.CallerId, docReq.VaultId, docReq.DocId, ct);
            else
                await guard.RequireDocumentReadAsync(docReq.CallerId, docReq.VaultId, docReq.DocId, ct);
        }

        return await next(ct);
    }
}
