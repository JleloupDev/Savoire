// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
namespace Savoire.Domain.ReadModels;

/// <summary>
/// Documents ANNEXES : rattaches a un autre document (les lots de lignes
/// legeres d'une base), d'id « {idDuDocument}~{nom} » (SessionTrees.ts,
/// annexDocId). Un annexe appartient toujours au vault de son document : le
/// registre le deduit, meme s'il n'a jamais ete inscrit (annexes crees avant
/// le registre), et refuse de l'inscrire ailleurs.
/// </summary>
public static class AnnexDocuments
{
    public const char Separator = '~';

    /// <summary>Le document d'un annexe ; null pour un document ordinaire.</summary>
    public static string? ParentOf(string docId)
    {
        int i = docId.IndexOf(Separator);
        return i > 0 && i < docId.Length - 1 ? docId[..i] : null;
    }
}
