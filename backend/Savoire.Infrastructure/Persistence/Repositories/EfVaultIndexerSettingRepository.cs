// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
using Microsoft.EntityFrameworkCore;
using Savoire.Domain.Enums;
using Savoire.Domain.ReadModels;
using Savoire.Domain.Repositories;

namespace Savoire.Infrastructure.Persistence.Repositories;

public class EfVaultIndexerSettingRepository(AppDbContext db) : IVaultIndexerSettingRepository
{
    public async Task<VaultIndexerSetting> GetAsync(string vaultId, CancellationToken ct = default)
    {
        VaultIndexerSettingEntity? e = await db.VaultIndexerSettings.AsNoTracking()
            .FirstOrDefaultAsync(s => s.VaultId == vaultId, ct);
        return e is null ? VaultIndexerSetting.Default(vaultId) : ToDomain(e);
    }

    public async Task<IReadOnlyDictionary<string, VaultIndexerSetting>> GetManyAsync(
        IReadOnlyCollection<string> vaultIds, CancellationToken ct = default)
    {
        string[] ids = vaultIds.Distinct().ToArray();
        Dictionary<string, VaultIndexerSetting> stored = await db.VaultIndexerSettings.AsNoTracking()
            .Where(s => ids.Contains(s.VaultId))
            .ToDictionaryAsync(s => s.VaultId, ToDomain, ct);
        return ids.ToDictionary(id => id, id => stored.GetValueOrDefault(id) ?? VaultIndexerSetting.Default(id));
    }

    public async Task SetAsync(VaultIndexerSetting setting, string updatedBy, CancellationToken ct = default)
    {
        await using var tx = await IndexerChangeWriter.BeginIfNoneAsync(db, ct);
        VaultIndexerSettingEntity? e = await db.VaultIndexerSettings.FirstOrDefaultAsync(s => s.VaultId == setting.VaultId, ct);
        bool wasManaged = e is null || e.Mode == IndexerMode.Managed.ToApiString();
        if (e is null)
        {
            e = new VaultIndexerSettingEntity { VaultId = setting.VaultId };
            db.VaultIndexerSettings.Add(e);
        }
        e.Mode      = setting.Mode.ToApiString();
        e.Url       = setting.Url;
        e.UpdatedBy = updatedBy;
        e.UpdatedAt = DateTime.UtcNow;
        await db.SaveChangesAsync(ct);

        // Le pair gere apprend par son flux qu'un vault entre ou sort de son perimetre.
        bool isManaged = setting.Mode == IndexerMode.Managed;
        if (wasManaged && !isManaged)
            await IndexerChangeWriter.RecordVaultGoneAsync(db, setting.VaultId, purgeRows: false, ct);
        else if (!wasManaged && isManaged)
            await IndexerChangeWriter.RecordVaultAsync(db, setting.VaultId, ct);
        if (tx is not null) await tx.CommitAsync(ct);
    }

    private static VaultIndexerSetting ToDomain(VaultIndexerSettingEntity e) =>
        new(e.VaultId, e.Mode.TryParseIndexerMode(out IndexerMode m) ? m : IndexerMode.Managed, e.Url);
}
