// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// Droits a date de fin (revue du 14/11/2026, M7) : chaque minute, les droits
// expires sont retires. Un membre dont le droit sur le vault a expire en
// sort ; un droit expire sur un document disparait. Les connexions ouvertes
// sont prevenues et sorties de leurs abonnements (notifications ci-dessous,
// HubSubscriptions). Le controle d'acces refuse deja un droit expire des la
// premiere seconde : ce balayage fait le menage et coupe la diffusion.

using MediatR;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Savoire.Application.Notifications;
using Savoire.Infrastructure.Persistence;

namespace Savoire.Infrastructure.Services;

public sealed class ExpiredPermissionSweeper(IServiceScopeFactory scopes, TimeProvider clock, ILogger<ExpiredPermissionSweeper> logger)
    : BackgroundService
{
    public static readonly TimeSpan Period = TimeSpan.FromMinutes(1);

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        using var timer = new PeriodicTimer(Period, clock);
        do
        {
            try { await SweepAsync(stoppingToken); }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                logger.LogWarning(ex, "Balayage des droits expires en echec.");
            }
        }
        while (await timer.WaitForNextTickAsync(stoppingToken));
    }

    /// <summary>Retire les droits expires. Rend leur nombre.</summary>
    public async Task<int> SweepAsync(CancellationToken ct)
    {
        await using AsyncServiceScope scope = scopes.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        var publisher = scope.ServiceProvider.GetRequiredService<IPublisher>();
        DateTime now = clock.GetUtcNow().UtcDateTime;
        List<ResourcePermissionEntity> expired = await db.ResourcePermissions
            .Where(p => p.ExpiresAt != null && p.ExpiresAt < now).ToListAsync(ct);
        if (expired.Count == 0) return 0;

        foreach (ResourcePermissionEntity p in expired.Where(p => p.ResourceType == "vault" && p.SubjectType == "user"))
            await db.VaultMembers.Where(m => m.VaultId == p.ResourceId && m.UserId == p.SubjectId).ExecuteDeleteAsync(ct);
        db.ResourcePermissions.RemoveRange(expired);
        await db.SaveChangesAsync(ct);

        foreach (string vaultId in expired.Where(p => p.ResourceType == "vault").Select(p => p.ResourceId).Distinct())
            await publisher.Publish(new VaultMembershipChangedNotification(vaultId), ct);
        foreach (ResourcePermissionEntity p in expired.Where(p => p.ResourceType == "document"))
            await publisher.Publish(new AccessRevokedNotification(p.ResourceId, p.SubjectId), ct);
        logger.LogInformation("{Count} droit(s) expire(s) retire(s).", expired.Count);
        return expired.Count;
    }
}
