// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
namespace Savoire.Domain.ReadModels;

/// <summary>Projection légère d'un lien de vault — utilisée pour initialiser le graphe côté client.</summary>
public record VaultLinkProjection(
    string  SourceId,
    string  SourcePath,
    string? TargetId,
    string  TargetPath,
    string  LinkType
);
