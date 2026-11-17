// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
using Savoire.Domain.Enums;

namespace Savoire.Domain.ReadModels;

/// <summary>
/// Reglage des droits d'un dossier ou d'un document : herite-t-il des droits
/// du niveau au-dessus (dossier parent, vault) ? Par defaut oui (aucune ligne).
/// Inherit = false : seuls les droits donnes a ce niveau (et le proprietaire,
/// les administrateurs du vault) valent pour lui et pour ce qu'il contient.
/// </summary>
public sealed record AclSetting(ResourceType ResourceType, string ResourceId, string VaultId, bool Inherit, string UpdatedBy, DateTime UpdatedAt);
