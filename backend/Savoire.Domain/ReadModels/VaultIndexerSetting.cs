// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
using Savoire.Domain.Enums;

namespace Savoire.Domain.ReadModels;

/// <summary>
/// Reglage « pair qui sert le vault ». Sans reglage enregistre, un vault est
/// servi par le pair gere (<see cref="Default"/>).
/// </summary>
public sealed record VaultIndexerSetting(string VaultId, IndexerMode Mode, string? Url)
{
    public static VaultIndexerSetting Default(string vaultId) => new(vaultId, IndexerMode.Managed, null);
}
