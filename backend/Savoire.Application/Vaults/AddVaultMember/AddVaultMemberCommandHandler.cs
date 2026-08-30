// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
using MediatR;
using Savoire.Application.Notifications;
using Savoire.Domain.Aggregates;
using Savoire.Domain.Enums;
using Savoire.Domain.Exceptions;
using Savoire.Domain.Repositories;
using Savoire.Domain.Services;

namespace Savoire.Application.Vaults.AddVaultMember;

public sealed class AddVaultMemberCommandHandler(
    IVaultRepository   vaults,
    IUserLookupService users,
    IPublisher         publisher)
    : IRequestHandler<AddVaultMemberCommand>
{
    public async Task Handle(AddVaultMemberCommand cmd, CancellationToken ct)
    {
        Vault vault = await vaults.GetByIdAsync(cmd.VaultId, ct)
            ?? throw new VaultNotFoundException(cmd.VaultId);

        vault.RequireOwner(cmd.CallerId);

        if (!await users.ExistsAsync(cmd.MemberId, ct))
            throw new AccessDeniedException($"Utilisateur inconnu : {cmd.MemberId}");

        if (vault.IsOwner(cmd.MemberId) ||
            await vaults.GetMemberAsync(cmd.VaultId, cmd.MemberId, ct) is not null)
            throw new PathConflictException($"L'utilisateur '{cmd.MemberId}' est déjà membre de ce vault.");

        var member = new VaultMember(cmd.VaultId, cmd.MemberId, cmd.Role.ParseVaultRole(), DateTime.UtcNow);
        await vaults.AddMemberAsync(member, ct);
        await publisher.Publish(new VaultMembershipChangedNotification(cmd.VaultId), ct);
    }
}
