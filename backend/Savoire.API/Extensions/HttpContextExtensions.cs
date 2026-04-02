// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// Extension to retrieve the userId from HttpContext.
// DECISION V2: Uses only the JWT Sub claim (X-User-Id removed).

using System.IdentityModel.Tokens.Jwt;
using System.Security.Claims;

namespace Savoire.Server.Extensions;

public static class HttpContextExtensions
{
    /// <summary>Returns the user ID from the JWT (Sub claim).</summary>
    public static string GetUserId(this HttpContext context) =>
        context.User.FindFirstValue(JwtRegisteredClaimNames.Sub)
        ?? throw new UnauthorizedAccessException("User not authenticated.");

    public static bool IsAdmin(this HttpContext context) =>
        context.User.FindFirstValue("is_admin") == "true";
}
