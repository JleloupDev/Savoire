// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
using MediatR;
using Savoire.Application.Common;
using Savoire.Domain.Repositories;

namespace Savoire.Application.Sync.ManagedVaultKeyring;

public sealed record PersistManagedVaultKeyringCommand(
    string VaultId,
    byte[] KeyringBytes,
    string CallerId
) : IRequest, IRequiresVaultAccess
{
    public VaultAccessLevel RequiredAccess => VaultAccessLevel.Write;
}

public sealed class PersistManagedVaultKeyringCommandHandler(IManagedVaultKeyringRepository keyrings)
    : IRequestHandler<PersistManagedVaultKeyringCommand>
{
    public async Task Handle(PersistManagedVaultKeyringCommand cmd, CancellationToken ct)
    {
        await keyrings.SetAsync(cmd.VaultId, cmd.KeyringBytes, ct);
    }
}
