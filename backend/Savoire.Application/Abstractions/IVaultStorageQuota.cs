// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// Quota de stockage (revue du 14/11/2026, E4 ; reglages : LimitsOptions).
//
// Le contenu d'un vault (fichiers, journal des notes, pages publiees) compte
// pour son proprietaire. Une requete qui ajoute du contenu le declare
// (IConsumesVaultStorage) : VaultStorageQuotaBehavior verifie qu'il reste de
// la place avant de la laisser passer.
namespace Savoire.Application.Abstractions;

/// <summary>Requete qui ajoute des octets au vault.</summary>
public interface IConsumesVaultStorage
{
    string VaultId { get; }
    long StorageBytes { get; }
    /// <summary>
    /// Vrai si l'ecriture remplace une donnee existante (dessin, page deja
    /// publiee) : la place est verifiee, mais rien n'est ajoute au compteur
    /// (il est recalcule periodiquement).
    /// </summary>
    bool ReplacesExisting => false;
}

/// <summary>Requete qui libere de la place (suppression, compaction) : le compteur du vault est recalcule.</summary>
public interface IReleasesVaultStorage
{
    string VaultId { get; }
}

public sealed record VaultUsage(string VaultId, string Name, long Bytes);

/// <summary>Ce qu'un compte occupe : ses vaults, et son quota (0 : sans limite).</summary>
public sealed record AccountUsage(long UsedBytes, long QuotaBytes, IReadOnlyList<VaultUsage> Vaults);

public interface IVaultStorageQuota
{
    /// <summary>
    /// Refuse (QuotaExceededException) si le proprietaire du vault n'a plus la
    /// place pour <paramref name="bytes"/> ; refuse les gros envois
    /// (StorageUnavailableException) si le disque du serveur est presque plein.
    /// </summary>
    Task EnsureRoomAsync(string vaultId, long bytes, CancellationToken ct = default);
    /// <summary>Des octets viennent d'etre ajoutes au vault.</summary>
    void Added(string vaultId, long bytes);
    /// <summary>Le contenu du vault a diminue : son compteur sera recalcule.</summary>
    void Invalidate(string vaultId);
    Task<AccountUsage> UsageOfAccountAsync(string userId, CancellationToken ct = default);
    /// <summary>Vaults possedes par ce compte.</summary>
    Task<int> OwnedVaultCountAsync(string userId, CancellationToken ct = default);
}
