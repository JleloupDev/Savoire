// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
using Microsoft.EntityFrameworkCore;
using Savoire.Domain.Enums;
using Savoire.Domain.ReadModels;
using Savoire.Domain.Repositories;

namespace Savoire.Infrastructure.Persistence.Repositories;

public class EfAclSettingRepository(AppDbContext db) : IAclSettingRepository
{
    public async Task<AclSetting?> GetAsync(ResourceType resourceType, string resourceId, CancellationToken ct = default)
    {
        string type = resourceType.ToApiString();
        AclSettingEntity? e = await db.AclSettings.AsNoTracking()
            .FirstOrDefaultAsync(s => s.ResourceType == type && s.ResourceId == resourceId, ct);
        return e is null ? null : new AclSetting(resourceType, e.ResourceId, e.VaultId, e.Inherit, e.UpdatedBy, e.UpdatedAt);
    }

    public async Task SetAsync(ResourceType resourceType, string resourceId, string vaultId, bool inherit, string updatedBy, CancellationToken ct = default)
    {
        string type = resourceType.ToApiString();
        AclSettingEntity? e = await db.AclSettings.FirstOrDefaultAsync(s => s.ResourceType == type && s.ResourceId == resourceId, ct);
        if (inherit)
        {
            if (e is not null) { db.AclSettings.Remove(e); await db.SaveChangesAsync(ct); }
            return;
        }
        if (e is null)
        {
            e = new AclSettingEntity { ResourceType = type, ResourceId = resourceId, VaultId = vaultId };
            db.AclSettings.Add(e);
        }
        e.Inherit = false;
        e.UpdatedBy = updatedBy;
        e.UpdatedAt = DateTime.UtcNow;
        await db.SaveChangesAsync(ct);
    }

    public async Task RenameFolderAsync(string vaultId, string from, string to, CancellationToken ct = default)
    {
        string oldId = FolderResource.Id(vaultId, from), newId = FolderResource.Id(vaultId, to);
        string oldPrefix = oldId + "/";
        int keep = oldId.Length + 1;
        string folderType = ResourceType.Folder.ToApiString();
        string oldFolder = FolderResource.Normalize(from)!, newFolder = FolderResource.Normalize(to)!;
        string oldFolderPrefix = oldFolder + "/";
        int keepFolder = oldFolder.Length + 1;
        await using var tx = db.Database.CurrentTransaction is null ? await db.Database.BeginTransactionAsync(ct) : null;
        // Le dossier lui-meme, puis ses sous-dossiers (meme debut de chemin).
        await db.Database.ExecuteSqlAsync($"""
            UPDATE acl_settings SET resource_id = {newId} || substr(resource_id, {keep})
            WHERE resource_type = {folderType} AND (resource_id = {oldId} OR starts_with(resource_id, {oldPrefix}))
            """, ct);
        await db.Database.ExecuteSqlAsync($"""
            UPDATE resource_permissions SET resource_id = {newId} || substr(resource_id, {keep})
            WHERE resource_type = {folderType} AND (resource_id = {oldId} OR starts_with(resource_id, {oldPrefix}))
            """, ct);
        // Les documents du dossier aussi : leurs droits suivent avant meme que le client les annonce.
        await db.Database.ExecuteSqlAsync($"""
            UPDATE vault_documents SET folder = {newFolder} || substr(folder, {keepFolder})
            WHERE vault_id = {vaultId} AND (folder = {oldFolder} OR starts_with(folder, {oldFolderPrefix}))
            """, ct);
        if (tx is not null) await tx.CommitAsync(ct);
    }
}
