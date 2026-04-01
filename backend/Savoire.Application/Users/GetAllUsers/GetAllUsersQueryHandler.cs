// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
using MediatR;
using Savoire.Application.Common;
using Savoire.Domain.Services;

namespace Savoire.Application.Users.GetAllUsers;

public class GetAllUsersQueryHandler(IUserLookupService users)
    : IRequestHandler<GetAllUsersQuery, IReadOnlyList<UserDto>>
{
    public async Task<IReadOnlyList<UserDto>> Handle(GetAllUsersQuery q, CancellationToken ct)
    {
        IReadOnlyList<UserInfo> allUsers = await users.GetAllAsync(ct);
        return allUsers.Select(UserDto.FromDomain).ToList();
    }
}
