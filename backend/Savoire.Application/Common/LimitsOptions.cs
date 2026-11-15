// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Limites d'usage (section « Limits ») : ce qu'un compte peut stocker et
// envoyer. Sans elles, un seul compte remplissait le disque, et avec lui la
// base : tout Savoire s'arretait (revue du 14/11/2026, E4).
//
// Stockage : le contenu d'un vault (fichiers, operations, pages publiees)
// compte pour son PROPRIETAIRE, quel que soit le membre qui ecrit.
// Debit : par compte, ou par adresse pour les routes sans compte.
// 0 desactive une limite.

namespace Savoire.Application.Common;

public sealed class LimitsOptions
{
    public const string Section = "Limits";

    /// <summary>Octets au plus pour tous les vaults d'un compte (fichiers, operations, pages publiees). Defaut : 5 Gio.</summary>
    public long AccountBytes { get; set; } = 5L * 1024 * 1024 * 1024;

    /// <summary>Vaults au plus par compte.</summary>
    public int VaultsPerAccount { get; set; } = 100;

    /// <summary>
    /// Place libre a garder sur le disque des donnees : en dessous, les gros
    /// envois (fichiers, pages publiees) sont refuses, pour tout le monde. La
    /// base est sur le meme disque. Defaut : 2 Gio.
    /// </summary>
    public long MinFreeDiskBytes { get; set; } = 2L * 1024 * 1024 * 1024;

    /// <summary>Un envoi plus petit que cela ne regarde pas la place libre (frappe au clavier). Defaut : 256 Kio.</summary>
    public long DiskCheckFromBytes { get; set; } = 256 * 1024;

    /// <summary>Appels aux hubs temps reel au plus, par minute et par compte (ou par lien).</summary>
    public int HubCallsPerMinute { get; set; } = 12_000;

    /// <summary>Envois de fichiers par minute et par compte.</summary>
    public int UploadsPerMinute { get; set; } = 120;

    /// <summary>Publications de pages par minute et par compte.</summary>
    public int PublishPerMinute { get; set; } = 30;

    /// <summary>Recherches d'un compte par adresse (pour inviter), par minute et par compte.</summary>
    public int LookupsPerMinute { get; set; } = 30;

    /// <summary>Creations de vault par minute et par compte.</summary>
    public int VaultCreationsPerMinute { get; set; } = 20;

    /// <summary>Routes sans compte (ouvrir un lien de partage, rapports d'erreurs), par minute et par adresse.</summary>
    public int AnonymousPerMinute { get; set; } = 120;
}
