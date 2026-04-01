// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
using MediatR;
using Savoire.Application.Common;
using Savoire.Domain.Aggregates;
using Savoire.Domain.Exceptions;
using Savoire.Domain.Repositories;
using Savoire.Domain.Services;
using Savoire.Domain.ValueObjects;

namespace Savoire.Application.Vaults.GetVaultDetail;

public class GetVaultDetailQueryHandler(
    IVaultRepository   vaults,
    IUserLookupService users)
    : IRequestHandler<GetVaultDetailQuery, VaultDetailDto>
{
    public async Task<VaultDetailDto> Handle(GetVaultDetailQuery q, CancellationToken ct)
    {
        Vault vault = await vaults.GetByIdAsync(q.VaultId, ct)
            ?? throw new VaultNotFoundException(q.VaultId);

        IReadOnlyList<VaultMember> members = await vaults.GetMembersAsync(q.VaultId, ct);
        string role = DetermineRole(q.CallerId, vault, members);
        VaultStats stats = await vaults.GetStatsAsync(q.VaultId, ct);

        var memberDtos = new List<VaultMemberDto>(members.Count);
        foreach (VaultMember m in members)
        {
            UserInfo? u = await users.GetByIdAsync(m.UserId, ct);
            memberDtos.Add(new VaultMemberDto(m.UserId, u?.DisplayName ?? m.UserId, m.Role));
        }

        return new VaultDetailDto(
            Id:             vault.Id,
            Name:           vault.Name,
            Role:           role,
            Members:        memberDtos,
            DocumentCount:  stats.DocumentCount,
            FolderCount:    stats.FolderCount,
            CreatedAt:      vault.CreatedAt,
            LastModifiedAt: stats.LastModifiedAt,
            SizeBytes:      stats.SizeBytes
        );
    }

    private static string DetermineRole(string callerId, Vault vault, IReadOnlyList<VaultMember> members)
    {
        if (vault.IsOwner(callerId)) return "owner";
        VaultMember? m = members.FirstOrDefault(m => m.UserId == callerId);
        if (m is null) throw new VaultNotFoundException(vault.Id); // Intentional: ne pas exposer l'existence
        return m.Role;
    }
}
