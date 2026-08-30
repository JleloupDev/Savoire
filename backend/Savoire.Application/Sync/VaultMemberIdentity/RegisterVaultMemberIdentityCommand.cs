// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
using MediatR;
using Savoire.Application.Common;
using Savoire.Domain.Repositories;

namespace Savoire.Application.Sync.VaultMemberIdentity;

public sealed record RegisterVaultMemberIdentityCommand(
    string VaultId,
    byte[] SignPub,
    string CallerId
) : IRequest, IRequiresVaultAccess
{
    public VaultAccessLevel RequiredAccess => VaultAccessLevel.Read;
}

public sealed class RegisterVaultMemberIdentityCommandHandler(IVaultMemberIdentityRepository identities)
    : IRequestHandler<RegisterVaultMemberIdentityCommand>
{
    public async Task Handle(RegisterVaultMemberIdentityCommand cmd, CancellationToken ct)
    {
        await identities.AddAsync(cmd.VaultId, cmd.CallerId, cmd.SignPub, ct);
    }
}
