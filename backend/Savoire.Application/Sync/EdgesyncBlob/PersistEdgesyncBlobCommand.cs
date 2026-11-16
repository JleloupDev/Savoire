// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
using MediatR;
using Savoire.Application.Common;
using Savoire.Domain.Repositories;
using Savoire.Application.Abstractions;

namespace Savoire.Application.Sync.EdgesyncBlob;

public sealed record PersistEdgesyncBlobCommand(
    string VaultId,
    string Key,
    byte[] Bytes,
    string CallerId
) : IRequest, IRequiresVaultAccess, IConsumesVaultStorage
{
    public VaultAccessLevel RequiredAccess => VaultAccessLevel.Write;
    public long StorageBytes => Bytes.Length;
    public bool ReplacesExisting => true;
}

public sealed class PersistEdgesyncBlobCommandHandler(IEdgesyncBlobRepository blobs)
    : IRequestHandler<PersistEdgesyncBlobCommand>
{
    public async Task Handle(PersistEdgesyncBlobCommand cmd, CancellationToken ct)
    {
        await blobs.SetAsync(cmd.VaultId, cmd.Key, cmd.Bytes, ct);
    }
}
