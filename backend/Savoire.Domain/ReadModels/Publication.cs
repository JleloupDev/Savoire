// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
namespace Savoire.Domain.ReadModels;

/// <summary>
/// Une page publiee sur le web : une note, rendue en HTML par l'application
/// de la personne qui l'edite, servie a tous sous /p/{slug}. Mise a jour a
/// chaque modification de la note (en direct, comme Notion).
/// </summary>
public sealed record Publication(
    string Slug,
    string VaultId,
    string DocumentId,
    string Title,
    string Description,
    string Html,
    bool Indexable,
    string CreatedBy,
    DateTime CreatedAt,
    DateTime UpdatedAt);

