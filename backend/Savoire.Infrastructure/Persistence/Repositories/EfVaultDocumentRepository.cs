// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
using Microsoft.EntityFrameworkCore;
using Savoire.Domain.ReadModels;
using Savoire.Domain.Repositories;

namespace Savoire.Infrastructure.Persistence.Repositories;

public class EfVaultDocumentRepository(AppDbContext db) : IVaultDocumentRepository
{
    public async Task<string?> GetVaultIdAsync(string docId, CancellationToken ct = default) =>
        await db.VaultDocuments
            .Where(d => d.DocId == docId)
            .Select(d => d.VaultId)
            .FirstOrDefaultAsync(ct);

    public async Task<IReadOnlyList<string>> RegisterAsync(
        string vaultId, IReadOnlyCollection<string> docIds, string registeredBy, CancellationToken ct = default)
    {
        string[] ids = docIds.Where(id => !string.IsNullOrWhiteSpace(id)).Distinct().ToArray();
        if (ids.Length == 0) return [];

        Dictionary<string, string> existing = await db.VaultDocuments
            .Where(d => ids.Contains(d.DocId))
            .ToDictionaryAsync(d => d.DocId, d => d.VaultId, ct);

        var rejected = new List<string>();
        DateTime now = DateTime.UtcNow;
        foreach (string id in ids)
        {
            if (existing.TryGetValue(id, out string? owner))
            {
                if (owner != vaultId) rejected.Add(id);
                continue;
            }
            db.VaultDocuments.Add(new VaultDocumentEntity
            {
                DocId = id, VaultId = vaultId, RegisteredBy = registeredBy, RegisteredAt = now,
            });
        }
        await db.SaveChangesAsync(ct);
        return rejected;
    }

    public async Task<VaultDocumentRecord?> GetAsync(string docId, CancellationToken ct = default) =>
        await db.VaultDocuments
            .Where(d => d.DocId == docId)
            .Select(d => new VaultDocumentRecord(d.DocId, d.VaultId, d.ParentDocId, d.Name))
            .FirstOrDefaultAsync(ct);

    public async Task SetPlacementAsync(string docId, string? parentDocId, string? name, CancellationToken ct = default)
    {
        VaultDocumentEntity? doc = await db.VaultDocuments.FirstOrDefaultAsync(d => d.DocId == docId, ct);
        if (doc is null) return;
        doc.ParentDocId = parentDocId;
        doc.Name = name;
        await db.SaveChangesAsync(ct);
    }

    public async Task<IReadOnlyList<VaultDocumentRecord>> ListChildrenAsync(
        string vaultId, string parentDocId, CancellationToken ct = default) =>
        await db.VaultDocuments
            .Where(d => d.VaultId == vaultId && d.ParentDocId == parentDocId)
            .Select(d => new VaultDocumentRecord(d.DocId, d.VaultId, d.ParentDocId, d.Name))
            .ToListAsync(ct);
}
