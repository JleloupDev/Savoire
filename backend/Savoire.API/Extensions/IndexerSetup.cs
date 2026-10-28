// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// Pair indexeur cote API : configuration (section « Indexer », validee au
// demarrage) et limitation de debit des routes publiques (limiteur integre
// d'ASP.NET Core) : un seau de jetons par personne, un par vault, enchaines.
// Depassement : 429 + Retry-After, corps { error: { code: "rate_limited" } }.

using System.Globalization;
using System.Threading.RateLimiting;
using Microsoft.AspNetCore.RateLimiting;
using Microsoft.Extensions.Options;
using Savoire.Application.Indexer;

namespace Savoire.Server.Extensions;

/// <summary>Routes soumises a la limitation de debit du pair indexeur.</summary>
[AttributeUsage(AttributeTargets.Class | AttributeTargets.Method)]
public sealed class IndexerRateLimitedAttribute : Attribute;

public static class IndexerSetup
{
    public static IServiceCollection AddIndexer(this IServiceCollection services, IConfiguration config)
    {
        services.AddOptions<IndexerOptions>()
            .Bind(config.GetSection(IndexerOptions.Section))
            .ValidateOnStart();
        services.AddSingleton<IValidateOptions<IndexerOptions>, IndexerOptionsChecks>();

        services.AddRateLimiter(o =>
        {
            o.RejectionStatusCode = StatusCodes.Status429TooManyRequests;
            o.GlobalLimiter = PartitionedRateLimiter.CreateChained(
                PartitionedRateLimiter.Create<HttpContext, string>(ctx => Partition(ctx, perVault: false)),
                PartitionedRateLimiter.Create<HttpContext, string>(ctx => Partition(ctx, perVault: true)));
            o.OnRejected = async (context, ct) =>
            {
                HttpResponse response = context.HttpContext.Response;
                int seconds = context.Lease.TryGetMetadata(MetadataName.RetryAfter, out TimeSpan retryAfter)
                    ? Math.Max(1, (int)Math.Ceiling(retryAfter.TotalSeconds))
                    : 1;
                response.Headers.RetryAfter = seconds.ToString(CultureInfo.InvariantCulture);
                response.ContentType = "application/json; charset=utf-8";
                await response.WriteAsync(IndexerReply.ErrorJson(IndexerErrorCodes.RateLimited,
                    "Trop de requetes vers le pair indexeur, reessayer plus tard.").ToJsonString(), ct);
            };
        });
        return services;
    }

    /// <summary>
    /// Seau de la personne (perVault false) ou du vault de la route (true) ;
    /// aucune limite hors des routes du pair indexeur.
    /// </summary>
    private static RateLimitPartition<string> Partition(HttpContext ctx, bool perVault)
    {
        if (ctx.GetEndpoint()?.Metadata.GetMetadata<IndexerRateLimitedAttribute>() is null)
            return RateLimitPartition.GetNoLimiter("");
        IndexerRateLimitOptions limits = ctx.RequestServices
            .GetRequiredService<IOptionsMonitor<IndexerOptions>>().CurrentValue.RateLimit;

        if (perVault)
        {
            return ctx.GetRouteValue("vaultId") is string vaultId
                ? RateLimitPartition.GetTokenBucketLimiter($"v:{vaultId}", _ => Bucket(limits.PerVaultPerMinute))
                : RateLimitPartition.GetNoLimiter("");
        }
        string? userId = ctx.User.FindFirst("sub")?.Value;
        return userId is null
            ? RateLimitPartition.GetNoLimiter("")
            : RateLimitPartition.GetTokenBucketLimiter($"u:{userId}", _ => Bucket(limits.PerUserPerMinute));
    }

    /// <summary>Un seau plein d'une minute de jetons, rempli au fil de l'eau.</summary>
    private static TokenBucketRateLimiterOptions Bucket(int perMinute)
    {
        perMinute = Math.Max(1, perMinute);
        bool slow = perMinute < 60;
        return new TokenBucketRateLimiterOptions
        {
            TokenLimit          = perMinute,
            TokensPerPeriod     = slow ? 1 : (int)Math.Ceiling(perMinute / 60.0),
            ReplenishmentPeriod = slow ? TimeSpan.FromSeconds(60.0 / perMinute) : TimeSpan.FromSeconds(1),
            QueueLimit          = 0,
            AutoReplenishment   = true,
        };
    }
}

/// <summary>Configuration Indexer invalide : le serveur refuse de demarrer, avec la raison.</summary>
public sealed class IndexerOptionsChecks : IValidateOptions<IndexerOptions>
{
    public ValidateOptionsResult Validate(string? name, IndexerOptions options)
    {
        IReadOnlyList<string> errors = options.Validate();
        return errors.Count == 0 ? ValidateOptionsResult.Success : ValidateOptionsResult.Fail(errors);
    }
}
