// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
using MediatR;
using Savoire.Application.Abstractions;

namespace Savoire.Application.Admin.Queries;

/// <summary>Ce que le compte occupe (ses vaults) et son quota. Voir IVaultStorageQuota.</summary>
public sealed record GetAccountUsageQuery(string UserId) : IRequest<AccountUsage>;

public sealed class GetAccountUsageQueryHandler(IVaultStorageQuota quota) : IRequestHandler<GetAccountUsageQuery, AccountUsage>
{
    public Task<AccountUsage> Handle(GetAccountUsageQuery q, CancellationToken ct) => quota.UsageOfAccountAsync(q.UserId, ct);
}
