// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// Extension pour récupérer le userId depuis HttpContext.
// DECISION V2: Utilise uniquement le claim Sub du JWT (X-User-Id supprimé).

using System.IdentityModel.Tokens.Jwt;
using System.Security.Claims;

namespace Savoire.Server.Extensions;

public static class HttpContextExtensions
{
    /// <summary>Récupère l'Id utilisateur depuis le JWT (claim Sub).</summary>
    public static string GetUserId(this HttpContext context) =>
        context.User.FindFirstValue(JwtRegisteredClaimNames.Sub)
        ?? throw new UnauthorizedAccessException("Utilisateur non authentifié.");

    public static bool IsAdmin(this HttpContext context) =>
        context.User.FindFirstValue("is_admin") == "true";
}
