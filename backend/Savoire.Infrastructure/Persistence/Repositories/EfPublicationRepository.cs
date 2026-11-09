// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
using Microsoft.EntityFrameworkCore;
using Savoire.Domain.ReadModels;
using Savoire.Domain.Repositories;

namespace Savoire.Infrastructure.Persistence.Repositories;

public class EfPublicationRepository(AppDbContext db) : IPublicationRepository
{
    private static Publication ToDomain(PublicationEntity e) => new(
        e.Slug, e.VaultId, e.DocumentId, e.Title, e.Description, e.Html, e.Indexable, e.CreatedBy, e.CreatedAt, e.UpdatedAt);

    public async Task<Publication?> GetBySlugAsync(string slug, CancellationToken ct = default)
    {
        PublicationEntity? e = await db.Publications.AsNoTracking().FirstOrDefaultAsync(p => p.Slug == slug, ct);
        return e is null ? null : ToDomain(e);
    }

    public async Task<Publication?> GetByDocumentAsync(string documentId, CancellationToken ct = default)
    {
        PublicationEntity? e = await db.Publications.AsNoTracking().FirstOrDefaultAsync(p => p.DocumentId == documentId, ct);
        return e is null ? null : ToDomain(e);
    }

    public Task<bool> SlugExistsAsync(string slug, CancellationToken ct = default)
        => db.Publications.AsNoTracking().AnyAsync(p => p.Slug == slug, ct);

    public async Task AddAsync(Publication p, CancellationToken ct = default)
    {
        db.Publications.Add(new PublicationEntity
        {
            Slug = p.Slug, VaultId = p.VaultId, DocumentId = p.DocumentId, Title = p.Title,
            Description = p.Description, Html = p.Html, Indexable = p.Indexable,
            CreatedBy = p.CreatedBy, CreatedAt = p.CreatedAt, UpdatedAt = p.UpdatedAt,
        });
        await db.SaveChangesAsync(ct);
    }

    public async Task UpdateAsync(string documentId, string title, string description, string html, bool indexable, DateTime at, CancellationToken ct = default)
    {
        await db.Publications.Where(p => p.DocumentId == documentId).ExecuteUpdateAsync(s => s
            .SetProperty(p => p.Title, title)
            .SetProperty(p => p.Description, description)
            .SetProperty(p => p.Html, html)
            .SetProperty(p => p.Indexable, indexable)
            .SetProperty(p => p.UpdatedAt, at), ct);
    }

    public async Task DeleteAsync(string documentId, CancellationToken ct = default)
        => await db.Publications.Where(p => p.DocumentId == documentId).ExecuteDeleteAsync(ct);
}
