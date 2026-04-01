// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
using Microsoft.AspNetCore.Identity;
using Microsoft.EntityFrameworkCore;
using Savoire.Application.Auth.Mappers;
using Savoire.Domain.Entities;
using Savoire.Domain.Interfaces;

namespace Savoire.Infrastructure.Auth;

public class IdentityUserService(UserManager<AppUser> userManager) : IUserService
{
    public async Task<IReadOnlyList<UserRecord>> GetAllUsersAsync(CancellationToken ct = default)
    {
        var users = await userManager.Users.ToListAsync(ct);
        return users.Select(UserMapper.ToRecord).ToList();
    }

    public async Task<UserRecord?> GetUserAsync(string userId, CancellationToken ct = default)
    {
        var user = await userManager.FindByIdAsync(userId);
        return user is null ? null : UserMapper.ToRecord(user);
    }

    public async Task<bool> ExistsAsync(string userId, CancellationToken ct = default)
        => await userManager.FindByIdAsync(userId) is not null;
}
