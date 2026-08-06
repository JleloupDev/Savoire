// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
using MediatR;
using Savoire.Application.Common;
using Savoire.Domain.Repositories;

namespace Savoire.Application.Sync.VaultKeyWrap;

public sealed record PersistVaultKeyWrapCommand(
    string VaultId,
    byte[] WrappedKeyBytes,
    string CallerId
) : IRequest, IRequiresVaultAccess
{
    public VaultAccessLevel RequiredAccess => VaultAccessLevel.Write;
}

public sealed class PersistVaultKeyWrapCommandHandler(IVaultKeyWrapRepository wraps)
    : IRequestHandler<PersistVaultKeyWrapCommand>
{
    public async Task Handle(PersistVaultKeyWrapCommand cmd, CancellationToken ct)
    {
        await wraps.SetAsync(cmd.CallerId, cmd.VaultId, cmd.WrappedKeyBytes, ct);
    }
}
