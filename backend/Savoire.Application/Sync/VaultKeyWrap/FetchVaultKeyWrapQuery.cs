// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
using MediatR;
using Savoire.Application.Common;
using Savoire.Domain.Repositories;

namespace Savoire.Application.Sync.VaultKeyWrap;

public sealed record FetchVaultKeyWrapQuery(string VaultId, string CallerId)
    : IRequest<byte[]?>, IRequiresVaultAccess
{
    public VaultAccessLevel RequiredAccess => VaultAccessLevel.Read;
}

public sealed class FetchVaultKeyWrapQueryHandler(IVaultKeyWrapRepository wraps)
    : IRequestHandler<FetchVaultKeyWrapQuery, byte[]?>
{
    public Task<byte[]?> Handle(FetchVaultKeyWrapQuery query, CancellationToken ct)
        => wraps.GetAsync(query.CallerId, query.VaultId, ct);
}
