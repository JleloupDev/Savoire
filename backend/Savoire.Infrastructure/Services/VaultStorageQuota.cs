// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// Quota de stockage (IVaultStorageQuota ; revue du 14/11/2026, E4).
//
// Ce qu'occupe un vault : ses fichiers (IContentStore), son journal CRDT
// (repertoire, index, notes, dessins), ses pages publiees et ses blobs
// EdgeSync. Le total est mesure a la demande puis garde en memoire ; chaque
// ajout l'augmente, et il est remesure toutes les dix minutes ou quand le
// contenu diminue. Mesurer a chaque frappe couterait une somme sur tout le
// journal ; un compteur approche suffit a arreter un abus.
//
// Le quota est celui du PROPRIETAIRE du vault : la somme de ses vaults.
// Une seule instance de l'API (ADR-028) : le compteur est dans ce processus.

using System.Collections.Concurrent;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;
using Savoire.Application.Abstractions;
using Savoire.Application.Common;
using Savoire.Domain.Exceptions;
using Savoire.Infrastructure.Persistence;

namespace Savoire.Infrastructure.Services;

public sealed class VaultStorageQuota(
    IServiceScopeFactory scopes,
    IContentStore files,
    IOptionsMonitor<LimitsOptions> limits,
    TimeProvider clock,
    StorageLocation storage) : IVaultStorageQuota
{
    private static readonly TimeSpan UsageTtl = TimeSpan.FromMinutes(10);
    private static readonly TimeSpan OwnerTtl = TimeSpan.FromMinutes(1);

    private sealed class Counter { public long Bytes; public DateTimeOffset At; }
    private sealed record Owned(string OwnerId, IReadOnlyList<(string Id, string Name)> Vaults, DateTimeOffset At);

    private readonly ConcurrentDictionary<string, Counter> usage = new();
    /// <summary>Par vault : son proprietaire et les vaults de celui-ci.</summary>
    private readonly ConcurrentDictionary<string, Owned> owners = new();

    public async Task EnsureRoomAsync(string vaultId, long bytes, CancellationToken ct = default)
    {
        LimitsOptions l = limits.CurrentValue;
        if (l.MinFreeDiskBytes > 0 && bytes >= l.DiskCheckFromBytes && storage.FreeBytes() is long free && free - bytes < l.MinFreeDiskBytes)
            throw new StorageUnavailableException();
        if (l.AccountBytes <= 0) return;

        Owned? owned = await OwnedByOwnerOfAsync(vaultId, ct);
        if (owned is null) return;   // vault inconnu : le controle d'acces l'a deja refuse
        long used = 0;
        foreach ((string id, _) in owned.Vaults) used += await BytesOfAsync(id, ct);
        if (used + bytes > l.AccountBytes)
            throw new QuotaExceededException(
                $"Le propriétaire de ce vault a atteint son quota de stockage ({Gb(l.AccountBytes)}). "
                + "Il faut libérer de la place (fichiers, vaults) pour y ajouter du contenu.");
    }

    public void Added(string vaultId, long bytes)
    {
        if (bytes > 0 && usage.TryGetValue(vaultId, out Counter? c)) Interlocked.Add(ref c.Bytes, bytes);
    }

    public void Invalidate(string vaultId)
    {
        usage.TryRemove(vaultId, out _);
        owners.TryRemove(vaultId, out _);
    }

    public async Task<AccountUsage> UsageOfAccountAsync(string userId, CancellationToken ct = default)
    {
        IReadOnlyList<(string Id, string Name)> vaults = await VaultsOwnedByAsync(userId, ct);
        var list = new List<VaultUsage>();
        foreach ((string id, string name) in vaults) list.Add(new VaultUsage(id, name, await BytesOfAsync(id, ct)));
        return new AccountUsage(list.Sum(v => v.Bytes), Math.Max(0, limits.CurrentValue.AccountBytes), list);
    }

    public async Task<int> OwnedVaultCountAsync(string userId, CancellationToken ct = default) =>
        (await VaultsOwnedByAsync(userId, ct)).Count;

    private static string Gb(long bytes) => $"{bytes / (1024d * 1024 * 1024):0.#} Go";

    private async Task<IReadOnlyList<(string Id, string Name)>> VaultsOwnedByAsync(string ownerId, CancellationToken ct)
    {
        await using AsyncServiceScope scope = scopes.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        var rows = await db.Vaults.AsNoTracking().Where(v => v.OwnerId == ownerId)
            .Select(v => new { v.Id, v.Name }).ToListAsync(ct);
        return rows.Select(r => (r.Id, r.Name)).ToList();
    }

    private async Task<Owned?> OwnedByOwnerOfAsync(string vaultId, CancellationToken ct)
    {
        DateTimeOffset now = clock.GetUtcNow();
        if (owners.TryGetValue(vaultId, out Owned? known) && now - known.At < OwnerTtl) return known;
        string? ownerId;
        await using (AsyncServiceScope scope = scopes.CreateAsyncScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
            ownerId = await db.Vaults.AsNoTracking().Where(v => v.Id == vaultId).Select(v => v.OwnerId).FirstOrDefaultAsync(ct);
        }
        if (ownerId is null) return null;
        var owned = new Owned(ownerId, await VaultsOwnedByAsync(ownerId, ct), now);
        owners[vaultId] = owned;
        return owned;
    }

    private async Task<long> BytesOfAsync(string vaultId, CancellationToken ct)
    {
        DateTimeOffset now = clock.GetUtcNow();
        if (usage.TryGetValue(vaultId, out Counter? c) && now - c.At < UsageTtl) return Interlocked.Read(ref c.Bytes);
        long bytes = await files.GetVaultBytesAsync(vaultId, ct) + await RowBytesAsync(vaultId, ct);
        usage[vaultId] = new Counter { Bytes = bytes, At = now };
        return bytes;
    }

    /// <summary>Octets du vault dans la base : journal CRDT, pages publiees, blobs EdgeSync.</summary>
    private async Task<long> RowBytesAsync(string vaultId, CancellationToken ct)
    {
        string vaultResource = "vault:" + vaultId;
        string indexPrefix = "index:" + vaultId + ":";
        await using AsyncServiceScope scope = scopes.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        return await db.Database.SqlQuery<long>($"""
            SELECT (
                COALESCE((SELECT sum(octet_length(op_bytes)) FROM operations_log
                          WHERE (resource_type IN ('document', 'room') AND resource_id IN (SELECT doc_id FROM vault_documents WHERE vault_id = {vaultId}))
                             OR (resource_type = 'vault' AND resource_id = {vaultResource})
                             OR (resource_type = 'index' AND starts_with(resource_id, {indexPrefix}))), 0)
              + COALESCE((SELECT sum(octet_length(html)) FROM publications WHERE vault_id = {vaultId}), 0)
              + COALESCE((SELECT sum(octet_length(bytes)) FROM edgesync_blobs WHERE vault_id = {vaultId}), 0)
            )::bigint AS "Value"
            """).SingleAsync(ct);
    }
}

/// <summary>Ou sont les fichiers, pour connaitre la place libre du disque (null : pas un disque local).</summary>
public sealed class StorageLocation(string? root)
{
    public long? FreeBytes()
    {
        if (root is null) return null;
        try
        {
            string full = Path.GetFullPath(root);
            Directory.CreateDirectory(full);
            return new DriveInfo(full).AvailableFreeSpace;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or ArgumentException)
        {
            return null;
        }
    }
}
