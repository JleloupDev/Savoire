// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
namespace Savoire.Domain.Enums;

/// <summary>
/// Pair indexeur qui sert un vault (ADR-027). Reglage du vault, modifiable
/// par son proprietaire, lisible par ses membres.
/// </summary>
public enum IndexerMode
{
    /// <summary>Pair gere par l'equipe Savoire (par defaut).</summary>
    Managed,
    /// <summary>Pair de l'organisation, a l'adresse donnee. Le serveur ne relaie pas.</summary>
    Organization,
    /// <summary>Aucun pair : le client se contente de son index local ou partage.</summary>
    None
}

public static class IndexerModeExtensions
{
    public static string ToApiString(this IndexerMode m) => m switch
    {
        IndexerMode.Managed      => "managed",
        IndexerMode.Organization => "organization",
        IndexerMode.None         => "none",
        _                        => throw new ArgumentOutOfRangeException(nameof(m), m, null)
    };

    public static bool TryParseIndexerMode(this string? s, out IndexerMode mode)
    {
        switch (s)
        {
            case "managed":      mode = IndexerMode.Managed;      return true;
            case "organization": mode = IndexerMode.Organization; return true;
            case "none":         mode = IndexerMode.None;         return true;
            default:             mode = IndexerMode.Managed;      return false;
        }
    }

    public static IndexerMode ParseIndexerMode(this string s) =>
        s.TryParseIndexerMode(out IndexerMode m) ? m : throw new ArgumentException($"Unknown IndexerMode: '{s}'");
}
