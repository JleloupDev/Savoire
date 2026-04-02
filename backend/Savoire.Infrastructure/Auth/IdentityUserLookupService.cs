// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
using Microsoft.AspNetCore.Identity;
using Microsoft.EntityFrameworkCore;
using Savoire.Domain.Entities;
using Savoire.Domain.Services;

namespace Savoire.Infrastructure.Auth;

/// <summary>
/// IUserLookupService implementation backed by ASP.NET Identity (UserManager).
/// Replaces ConfigUserService (static config read) for dynamically created users.
/// </summary>
public class IdentityUserLookupService(UserManager<AppUser> userManager) : IUserLookupService
{
    public async Task<IReadOnlyList<UserInfo>> GetAllAsync(CancellationToken ct = default)
    {
        var users = await userManager.Users.ToListAsync(ct);
        return users.Select(u => new UserInfo(u.Id, u.DisplayName, string.Empty)).ToList();
    }

    public async Task<UserInfo?> GetByIdAsync(string userId, CancellationToken ct = default)
    {
        var user = await userManager.FindByIdAsync(userId);
        return user is null ? null : new UserInfo(user.Id, user.DisplayName, string.Empty);
    }

    public async Task<bool> ExistsAsync(string userId, CancellationToken ct = default)
        => await userManager.FindByIdAsync(userId) is not null;
}
