// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Limitation de debit des routes de l'API (section « Limits », voir
// LimitsOptions) : un seau de jetons par compte, ou par adresse pour les
// routes sans compte. Une route se declare par [RateLimited(policy)].
// Depassement : 429 + Retry-After. Le limiteur est celui d'ASP.NET Core,
// enchaine avec celui du pair indexeur (IndexerSetup).

using System.Threading.RateLimiting;
using Microsoft.Extensions.Options;
using Savoire.Application.Common;

namespace Savoire.Server.Extensions;

public static class RatePolicies
{
    public const string Upload = "upload";
    public const string Publish = "publish";
    public const string Lookup = "lookup";
    public const string VaultCreate = "vault-create";
    /// <summary>Routes sans compte : compte par adresse.</summary>
    public const string Anonymous = "anonymous";
}

/// <summary>Route soumise a une limite de debit (voir RatePolicies).</summary>
[AttributeUsage(AttributeTargets.Class | AttributeTargets.Method)]
public sealed class RateLimitedAttribute(string policy) : Attribute
{
    public string Policy { get; } = policy;
}

public static class RateLimits
{
    private static int PerMinute(LimitsOptions limits, string policy) => policy switch
    {
        RatePolicies.Upload      => limits.UploadsPerMinute,
        RatePolicies.Publish     => limits.PublishPerMinute,
        RatePolicies.Lookup      => limits.LookupsPerMinute,
        RatePolicies.VaultCreate => limits.VaultCreationsPerMinute,
        RatePolicies.Anonymous   => limits.AnonymousPerMinute,
        _                        => 0,
    };

    /// <summary>Le seau d'une requete : aucun hors des routes [RateLimited].</summary>
    public static RateLimitPartition<string> Partition(HttpContext ctx)
    {
        RateLimitedAttribute? rule = ctx.GetEndpoint()?.Metadata.GetMetadata<RateLimitedAttribute>();
        if (rule is null) return RateLimitPartition.GetNoLimiter("");
        LimitsOptions limits = ctx.RequestServices.GetRequiredService<IOptionsMonitor<LimitsOptions>>().CurrentValue;
        int perMinute = PerMinute(limits, rule.Policy);
        if (perMinute <= 0) return RateLimitPartition.GetNoLimiter("");

        // Routes sans compte : par adresse, meme si un jeton est presente (il
        // ne coute rien d'en fabriquer). Les autres : par compte.
        string? who = rule.Policy == RatePolicies.Anonymous ? null : ctx.User.FindFirst("sub")?.Value;
        string key = who is not null
            ? $"{rule.Policy}:u:{who}"
            : $"{rule.Policy}:ip:{ctx.Connection.RemoteIpAddress?.ToString() ?? "inconnue"}";
        return RateLimitPartition.GetTokenBucketLimiter(key, _ => IndexerSetup.Bucket(perMinute));
    }

    public static bool Applies(HttpContext ctx) =>
        ctx.GetEndpoint()?.Metadata.GetMetadata<RateLimitedAttribute>() is not null;
}
