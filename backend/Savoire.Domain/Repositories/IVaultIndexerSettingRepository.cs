// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
using Savoire.Domain.ReadModels;

namespace Savoire.Domain.Repositories;

/// <summary>Reglage « pair qui sert le vault » (ADR-027).</summary>
public interface IVaultIndexerSettingRepository
{
    /// <summary>Le reglage du vault ; le pair gere s'il n'y en a pas.</summary>
    Task<VaultIndexerSetting> GetAsync(string vaultId, CancellationToken ct = default);

    /// <summary>Les reglages de ces vaults, chacun present (pair gere par defaut).</summary>
    Task<IReadOnlyDictionary<string, VaultIndexerSetting>> GetManyAsync(
        IReadOnlyCollection<string> vaultIds, CancellationToken ct = default);

    /// <summary>
    /// Enregistre le reglage. Un vault qui entre dans le pair gere ou en sort
    /// est signale dans le flux de changements (« vault » ou « vault-deleted »),
    /// dans la meme transaction.
    /// </summary>
    Task SetAsync(VaultIndexerSetting setting, string updatedBy, CancellationToken ct = default);
}
