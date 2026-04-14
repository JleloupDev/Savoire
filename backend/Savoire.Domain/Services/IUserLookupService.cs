// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
namespace Savoire.Domain.Services;

public interface IUserLookupService
{
    Task<IReadOnlyList<UserInfo>> GetAllAsync(CancellationToken ct = default);
    Task<UserInfo?> GetByIdAsync(string userId, CancellationToken ct = default);
    Task<UserInfo?> GetByEmailAsync(string email, CancellationToken ct = default);
    Task<bool> ExistsAsync(string userId, CancellationToken ct = default);
}

public record UserInfo(string Id, string DisplayName, string DefaultVaultPath);
