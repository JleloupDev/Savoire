// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
namespace Savoire.Domain.Interfaces;

public interface IUserService
{
    Task<IReadOnlyList<UserRecord>> GetAllUsersAsync(CancellationToken ct = default);
    Task<UserRecord?> GetUserAsync(string userId, CancellationToken ct = default);
    Task<bool> ExistsAsync(string userId, CancellationToken ct = default);
}

public record UserRecord(string Id, string DisplayName, string Email, bool IsAdmin);
