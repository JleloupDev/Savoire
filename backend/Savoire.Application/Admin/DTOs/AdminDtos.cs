// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
namespace Savoire.Application.Admin.DTOs;

public record CreateUserRequest(
    string Email,
    string Password,
    string DisplayName,
    bool IsAdmin = false);

public record ResetPasswordRequest(string NewPassword);

public record AdminUserDto(
    string Id,
    string Email,
    string DisplayName,
    bool IsAdmin,
    DateTime CreatedAt,
    DateTime? LastLoginAt,
    bool IsLockedOut
);
