// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// Repartition des vaults entre les instances du pair indexeur : hachage de
// rendez-vous (docs/Architecture/indexer-protocol.md, « Repartition »).
//
// Pour chaque instance, h = FNV-1a 64 bits des octets UTF-8 de
// name + "|" + vaultId ; l'instance de plus grand h (entier non signe)
// possede le vault ; a egalite, le plus petit nom (ordre ordinal). Ajouter une
// instance ne deplace qu'environ 1/n des vaults. Vecteurs de test : voir le
// protocole et IndexerRoutingTests.

using System.Text;

namespace Savoire.Application.Indexer;

public static class IndexerRouting
{
    private const ulong FnvOffsetBasis = 0xcbf29ce484222325;
    private const ulong FnvPrime       = 0x100000001b3;

    /// <summary>FNV-1a 64 bits des octets UTF-8 du texte.</summary>
    public static ulong Fnv1a64(string text)
    {
        ulong h = FnvOffsetBasis;
        foreach (byte b in Encoding.UTF8.GetBytes(text))
        {
            h ^= b;
            unchecked { h *= FnvPrime; }
        }
        return h;
    }

    /// <summary>Poids de l'instance pour ce vault.</summary>
    public static ulong Weight(string instanceName, string vaultId) => Fnv1a64(instanceName + "|" + vaultId);

    /// <summary>L'instance qui possede le vault, ou null s'il n'y en a aucune.</summary>
    public static IndexerInstanceOptions? OwnerOf(string vaultId, IReadOnlyList<IndexerInstanceOptions> instances)
    {
        IndexerInstanceOptions? best = null;
        ulong bestWeight = 0;
        foreach (IndexerInstanceOptions instance in instances)
        {
            ulong w = Weight(instance.Name, vaultId);
            if (best is null || w > bestWeight
                || (w == bestWeight && string.CompareOrdinal(instance.Name, best.Name) < 0))
            {
                best = instance;
                bestWeight = w;
            }
        }
        return best;
    }

    /// <summary>Vrai si l'instance <paramref name="instanceName"/> possede le vault.</summary>
    public static bool IsOwner(string instanceName, string vaultId, IReadOnlyList<IndexerInstanceOptions> instances) =>
        string.Equals(OwnerOf(vaultId, instances)?.Name, instanceName, StringComparison.Ordinal);
}
