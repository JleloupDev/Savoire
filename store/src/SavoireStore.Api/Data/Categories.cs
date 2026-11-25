// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Les categories du store. Le manifeste en donne jusqu'a cinq (« categories ») ;
// elles sont rangees sous forme de slug (« Écriture » devient « ecriture »).
// Les categories connues ont un nom et une phrase ; une autre garde son slug.
using System.Globalization;
using System.Text;

namespace SavoireStore.Data;

public sealed record Category(string Slug, string Name, string Description);

public static class Categories
{
    public static readonly IReadOnlyList<Category> Known =
    [
        new("organisation", "Organisation", "Tâches, kanban, agenda, projets."),
        new("ecriture", "Écriture", "Rédiger, relire, mettre en forme."),
        new("productivite", "Productivité", "Raccourcis, automatismes, gain de temps."),
        new("recherche", "Recherche et études", "Sources, citations, fiches de lecture."),
        new("visualisation", "Visualisation", "Graphes, diagrammes, cartes, tableaux."),
        new("ia", "Intelligence artificielle", "Agents, résumés, assistants."),
        new("apparence", "Apparence", "Thèmes, polices, mise en page."),
        new("import-export", "Import et export", "Faire entrer et sortir vos notes."),
        new("collaboration", "Collaboration", "Travailler à plusieurs, partager."),
        new("enseignement", "Enseignement", "Cours, exercices, révisions."),
        new("lecture", "Lecture et références", "Livres, textes de référence, bibliothèques."),
        new("developpement", "Développement", "Code, outils pour développeurs."),
    ];

    private static readonly Dictionary<string, Category> BySlug = Known.ToDictionary(c => c.Slug);

    public static Category Of(string slug) =>
        BySlug.TryGetValue(slug, out Category? c) ? c : new Category(slug, char.ToUpperInvariant(slug[0]) + slug[1..].Replace('-', ' '), "");

    /// <summary>« Import & Export » devient « import-export » : minuscules, sans accent, tirets.</summary>
    public static string Slug(string name)
    {
        var sb = new StringBuilder();
        foreach (char ch in name.Trim().ToLowerInvariant().Normalize(NormalizationForm.FormD))
        {
            if (CharUnicodeInfo.GetUnicodeCategory(ch) == UnicodeCategory.NonSpacingMark) continue;
            if (ch is >= 'a' and <= 'z' or >= '0' and <= '9') sb.Append(ch);
            else if (sb.Length > 0 && sb[^1] != '-') sb.Append('-');
        }
        string s = sb.ToString().Trim('-');
        return s.Length > 40 ? s[..40].Trim('-') : s;
    }
}
