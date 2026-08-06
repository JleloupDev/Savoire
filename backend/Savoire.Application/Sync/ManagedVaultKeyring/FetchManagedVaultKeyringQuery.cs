// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
using MediatR;
using Savoire.Application.Common;
using Savoire.Domain.Repositories;

namespace Savoire.Application.Sync.ManagedVaultKeyring;

public sealed record FetchManagedVaultKeyringQuery(string VaultId, string CallerId)
    : IRequest<byte[]?>, IRequiresVaultAccess
{
    public VaultAccessLevel RequiredAccess => VaultAccessLevel.Read;
}

public sealed class FetchManagedVaultKeyringQueryHandler(IManagedVaultKeyringRepository keyrings)
    : IRequestHandler<FetchManagedVaultKeyringQuery, byte[]?>
{
    public Task<byte[]?> Handle(FetchManagedVaultKeyringQuery query, CancellationToken ct)
        => keyrings.GetAsync(query.VaultId, ct);
}
