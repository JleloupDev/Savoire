// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
using Savoire.Application.Admin.DTOs;
using Savoire.Application.Auth.DTOs;
using Savoire.Domain.Entities;
using Savoire.Domain.Interfaces;

namespace Savoire.Application.Auth.Mappers;

public static class UserMapper
{
    public static AuthUserDto ToDto(AppUser user) =>
        new(user.Id, user.DisplayName, user.Email!, user.IsAdmin);

    public static AdminUserDto ToAdminDto(AppUser user, bool isLockedOut) =>
        new(user.Id, user.Email!, user.DisplayName, user.IsAdmin,
            user.CreatedAt, user.LastLoginAt, isLockedOut);

    public static UserRecord ToRecord(AppUser user) =>
        new(user.Id, user.DisplayName, user.Email!, user.IsAdmin);
}
