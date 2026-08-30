// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
using MediatR;
using Savoire.Application.Common;
using Savoire.Domain.Repositories;

namespace Savoire.Application.Sync.EdgesyncBlob;

public sealed record FetchEdgesyncBlobQuery(string VaultId, string Key, string CallerId)
    : IRequest<byte[]?>, IRequiresVaultAccess
{
    public VaultAccessLevel RequiredAccess => VaultAccessLevel.Read;
}

public sealed class FetchEdgesyncBlobQueryHandler(IEdgesyncBlobRepository blobs)
    : IRequestHandler<FetchEdgesyncBlobQuery, byte[]?>
{
    public Task<byte[]?> Handle(FetchEdgesyncBlobQuery query, CancellationToken ct)
        => blobs.GetAsync(query.VaultId, query.Key, ct);
}
