// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
using Savoire.Domain.ReadModels;

namespace Savoire.Domain.Repositories;

public interface IPublicationRepository
{
    Task<Publication?> GetBySlugAsync(string slug, CancellationToken ct = default);
    Task<Publication?> GetByDocumentAsync(string documentId, CancellationToken ct = default);
    Task<bool> SlugExistsAsync(string slug, CancellationToken ct = default);
    Task AddAsync(Publication publication, CancellationToken ct = default);
    /// <summary>Contenu et reglages d'une publication existante.</summary>
    Task UpdateAsync(string documentId, string title, string description, string html, bool indexable, DateTime at, CancellationToken ct = default);
    Task DeleteAsync(string documentId, CancellationToken ct = default);
}
