// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// Jeton de service de l'API interne du pair indexeur
// (docs/Architecture/indexer-protocol.md) : Authorization: Bearer <jeton>.
//
// Sans jeton configure (Indexer:ServiceToken), l'API interne n'existe pas :
// 404. Jeton absent ou faux : 401. La comparaison se fait en temps constant
// sur les empreintes SHA-256 : ni le contenu ni la longueur du jeton ne
// fuient par le temps de reponse.

using System.Security.Cryptography;
using System.Text;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.Filters;
using Microsoft.Extensions.Options;
using Savoire.Application.Indexer;

namespace Savoire.Server.Middleware;

[AttributeUsage(AttributeTargets.Class | AttributeTargets.Method)]
public sealed class IndexerServiceTokenAttribute : Attribute, IAuthorizationFilter
{
    public void OnAuthorization(AuthorizationFilterContext context)
    {
        IndexerOptions opts = context.HttpContext.RequestServices
            .GetRequiredService<IOptionsMonitor<IndexerOptions>>().CurrentValue;
        if (!opts.Enabled)
        {
            context.Result = new NotFoundResult();
            return;
        }

        string? presented = BearerToken(context.HttpContext.Request.Headers.Authorization.ToString());
        if (presented is null || !TokenMatches(presented, opts.ServiceToken!))
        {
            context.HttpContext.Response.Headers.WWWAuthenticate = "Bearer";
            context.Result = new ContentResult
            {
                StatusCode  = StatusCodes.Status401Unauthorized,
                ContentType = "application/json; charset=utf-8",
                Content     = IndexerReply.ErrorJson("unauthorized", "Jeton de service absent ou invalide.").ToJsonString(),
            };
        }
    }

    private static string? BearerToken(string header) =>
        header.StartsWith("Bearer ", StringComparison.OrdinalIgnoreCase) && header.Length > 7
            ? header[7..].Trim()
            : null;

    public static bool TokenMatches(string presented, string expected) =>
        CryptographicOperations.FixedTimeEquals(
            SHA256.HashData(Encoding.UTF8.GetBytes(presented)),
            SHA256.HashData(Encoding.UTF8.GetBytes(expected)));
}
