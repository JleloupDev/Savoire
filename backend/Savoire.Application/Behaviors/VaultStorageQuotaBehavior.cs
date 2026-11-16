// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
using MediatR;
using Savoire.Application.Abstractions;

namespace Savoire.Application.Behaviors;

/// <summary>
/// Quota de stockage : toute requete qui ajoute du contenu a un vault
/// (IConsumesVaultStorage) passe ici, APRES le controle d'acces. Voir
/// IVaultStorageQuota.
/// </summary>
public class VaultStorageQuotaBehavior<TRequest, TResponse>(IVaultStorageQuota quota)
    : IPipelineBehavior<TRequest, TResponse>
    where TRequest : notnull
{
    public async Task<TResponse> Handle(TRequest request, RequestHandlerDelegate<TResponse> next, CancellationToken ct)
    {
        if (request is IConsumesVaultStorage consumes)
        {
            await quota.EnsureRoomAsync(consumes.VaultId, consumes.StorageBytes, ct);
            TResponse response = await next(ct);
            if (!consumes.ReplacesExisting) quota.Added(consumes.VaultId, consumes.StorageBytes);
            return response;
        }
        if (request is IReleasesVaultStorage releases)
        {
            TResponse response = await next(ct);
            quota.Invalidate(releases.VaultId);
            return response;
        }
        return await next(ct);
    }
}
