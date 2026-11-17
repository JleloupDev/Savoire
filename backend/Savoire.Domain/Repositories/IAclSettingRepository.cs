// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
using Savoire.Domain.Enums;
using Savoire.Domain.ReadModels;

namespace Savoire.Domain.Repositories;

/// <summary>Reglages d'heritage des droits (voir AclSetting).</summary>
public interface IAclSettingRepository
{
    Task<AclSetting?> GetAsync(ResourceType resourceType, string resourceId, CancellationToken ct = default);
    /// <summary>Inherit = true efface le reglage (c'est le comportement par defaut).</summary>
    Task SetAsync(ResourceType resourceType, string resourceId, string vaultId, bool inherit, string updatedBy, CancellationToken ct = default);
    /// <summary>Un dossier renomme ou deplace : ses reglages et droits, et ceux de ses sous-dossiers, suivent.</summary>
    Task RenameFolderAsync(string vaultId, string from, string to, CancellationToken ct = default);
}
