// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
using MediatR;
using Savoire.Application.Common;
using Savoire.Domain.Aggregates;
using Savoire.Domain.Exceptions;
using Savoire.Domain.Repositories;

namespace Savoire.Application.Sync.VaultMemberIdentity;

public sealed record VaultMemberIdentitiesDto(IReadOnlyList<string> SignPubsBase64);

public sealed record GetVaultMemberIdentitiesQuery(string VaultId, string CallerId)
    : IRequest<VaultMemberIdentitiesDto>, IRequiresVaultAccess
{
    public VaultAccessLevel RequiredAccess => VaultAccessLevel.Read;
}

public sealed class GetVaultMemberIdentitiesQueryHandler(
    IVaultRepository vaults,
    IVaultMemberIdentityRepository identities)
    : IRequestHandler<GetVaultMemberIdentitiesQuery, VaultMemberIdentitiesDto>
{
    public async Task<VaultMemberIdentitiesDto> Handle(GetVaultMemberIdentitiesQuery query, CancellationToken ct)
    {
        Vault vault = await vaults.GetByIdAsync(query.VaultId, ct)
            ?? throw new VaultNotFoundException(query.VaultId);

        // Union owner ∪ vault_members — the owner has no row in vault_members
        // (VaultAccessGuard bypasses that table entirely for owners), so
        // without this a never-shared vault would lock out its own owner.
        var authorizedUserIds = new HashSet<string>(StringComparer.Ordinal) { vault.OwnerId };
        IReadOnlyList<VaultMember> members = await vaults.GetMembersAsync(query.VaultId, ct);
        foreach (VaultMember member in members) authorizedUserIds.Add(member.UserId);

        IReadOnlyList<(string UserId, byte[] SignPub)> registered = await identities.GetAllAsync(query.VaultId, ct);
        List<string> signPubsBase64 = [.. registered
            .Where(r => authorizedUserIds.Contains(r.UserId))
            .Select(r => Convert.ToBase64String(r.SignPub))];

        return new VaultMemberIdentitiesDto(signPubsBase64);
    }
}
