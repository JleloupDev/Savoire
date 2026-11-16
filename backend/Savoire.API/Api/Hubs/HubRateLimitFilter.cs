// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// Limite d'appels des hubs temps reel (Limits:HubCallsPerMinute ; revue du
// 14/11/2026, E4) : un seau de jetons par compte (ou par lien de partage).
// Large : une frappe au clavier ou l'envoi d'un vault entier passent ; une
// boucle qui inonde le serveur est arretee. Le quota de stockage, lui, borne
// le volume (VaultStorageQuotaBehavior).
//
// Ajoute APRES HubErrorFilter : celui-ci traduit le refus en « rate-limited ».

using System.Threading.RateLimiting;
using Microsoft.AspNetCore.SignalR;
using Microsoft.Extensions.Options;
using Savoire.Application.Common;
using Savoire.Domain.Exceptions;
using Savoire.Server.Extensions;

namespace Savoire.Server.Hubs;

/// <summary>Les seaux, partages par toutes les connexions.</summary>
public sealed class HubCallLimiter(IOptionsMonitor<LimitsOptions> limits) : IDisposable
{
    private readonly PartitionedRateLimiter<string> limiter = PartitionedRateLimiter.Create<string, string>(key =>
        RateLimitPartition.GetTokenBucketLimiter(key, _ => IndexerSetup.Bucket(limits.CurrentValue.HubCallsPerMinute)));

    /// <summary>Faux si ce compte a epuise son seau.</summary>
    public bool TryAcquire(string caller)
    {
        if (limits.CurrentValue.HubCallsPerMinute <= 0) return true;
        using RateLimitLease lease = limiter.AttemptAcquire(caller);
        return lease.IsAcquired;
    }

    public void Dispose() => limiter.Dispose();
}

public sealed class HubRateLimitFilter(HubCallLimiter limiter) : IHubFilter
{
    public ValueTask<object?> InvokeMethodAsync(
        HubInvocationContext invocationContext,
        Func<HubInvocationContext, ValueTask<object?>> next)
    {
        string caller = invocationContext.Context.User?.FindFirst("sub")?.Value ?? invocationContext.Context.ConnectionId;
        if (!limiter.TryAcquire(caller)) throw new TooManyRequestsException();
        return next(invocationContext);
    }
}
