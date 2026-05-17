// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
using MediatR;
using Microsoft.AspNetCore.Identity;
using Savoire.Application.Admin.DTOs;
using Savoire.Application.Auth.Mappers;
using Savoire.Domain.Entities;

namespace Savoire.Application.Admin.Queries;

public sealed record ListUsersQuery : IRequest<IReadOnlyList<AdminUserDto>>;

public sealed class ListUsersQueryHandler(
    UserManager<AppUser> userManager) :
    IRequestHandler<ListUsersQuery, IReadOnlyList<AdminUserDto>>
{
    public async Task<IReadOnlyList<AdminUserDto>> Handle(
        ListUsersQuery request, CancellationToken ct)
    {
        var users = userManager.Users
            .OrderBy(u => u.CreatedAt)
            .ToList();

        var result = new List<AdminUserDto>();
        foreach (var user in users)
        {
            var isLockedOut = await userManager.IsLockedOutAsync(user);
            result.Add(UserMapper.ToAdminDto(user, isLockedOut));
        }
        return result;
    }
}
