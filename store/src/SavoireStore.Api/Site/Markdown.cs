// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Un Markdown reduit pour les descriptions des elements (longDescription) et
// la page « Publier » : titres, paragraphes, listes, citations, blocs de code,
// tableaux, gras, italique, code, liens. Tout le texte est echappe d'abord :
// aucun HTML de l'editeur ne passe. Liens http(s), ancres et chemins du site
// seulement, en rel="nofollow noopener".
using System.Net;
using System.Text;
using System.Text.RegularExpressions;

namespace SavoireStore.Site;

public static partial class Markdown
{
    [GeneratedRegex(@"^(#{1,4})\s+(.+?)\s*#*$")]
    private static partial Regex Heading();

    [GeneratedRegex(@"^\s*[-*+]\s+(.*)$")]
    private static partial Regex Bullet();

    [GeneratedRegex(@"^\s*\d{1,3}[.)]\s+(.*)$")]
    private static partial Regex Numbered();

    [GeneratedRegex(@"^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$")]
    private static partial Regex TableRule();

    [GeneratedRegex(@"`([^`]+)`")]
    private static partial Regex CodeSpan();

    [GeneratedRegex(@"\[([^\]]+)\]\(([^)\s]+)\)")]
    private static partial Regex Link();

    [GeneratedRegex(@"\*\*(.+?)\*\*")]
    private static partial Regex Bold();

    [GeneratedRegex(@"(?<![\w*])\*(?!\s)(.+?)(?<!\s)\*(?![\w*])|(?<![\w_])_(?!\s)(.+?)(?<!\s)_(?![\w_])")]
    private static partial Regex Italic();

    /// <summary>Le HTML du texte. `headingShift` descend les titres (# devient h2 avec 1).</summary>
    public static string ToHtml(string? text, int headingShift = 1, string basePath = "")
    {
        if (string.IsNullOrWhiteSpace(text)) return "";
        string[] lines = text.Replace("\r\n", "\n").Replace('\r', '\n').Split('\n');
        var sb = new StringBuilder();
        var paragraph = new List<string>();
        void Flush()
        {
            if (paragraph.Count == 0) return;
            // Un retour a la ligne dans un paragraphe est un espace (Markdown) ; deux espaces en fin de ligne : un vrai retour.
            sb.Append("<p>").Append(Inline(string.Join(" ", paragraph), basePath).Replace("\u0003", "<br>")).Append("</p>");
            paragraph.Clear();
        }

        for (int i = 0; i < lines.Length; i++)
        {
            string line = lines[i];
            string trimmed = line.Trim();
            if (trimmed.Length == 0) { Flush(); continue; }

            if (trimmed.StartsWith("```", StringComparison.Ordinal))
            {
                Flush();
                var code = new StringBuilder();
                for (i++; i < lines.Length && !lines[i].Trim().StartsWith("```", StringComparison.Ordinal); i++) code.Append(lines[i]).Append('\n');
                sb.Append("<pre><code>").Append(WebUtility.HtmlEncode(code.ToString().TrimEnd('\n'))).Append("</code></pre>");
                continue;
            }
            if (Heading().Match(trimmed) is { Success: true } h)
            {
                Flush();
                int level = Math.Min(6, h.Groups[1].Length + headingShift);
                string inner = Inline(h.Groups[2].Value, basePath);
                sb.Append($"<h{level} id=\"{Anchor(h.Groups[2].Value)}\">{inner}</h{level}>");
                continue;
            }
            if (trimmed is "---" or "***" or "___") { Flush(); sb.Append("<hr>"); continue; }
            if (trimmed.StartsWith('>'))
            {
                Flush();
                var quote = new List<string>();
                for (; i < lines.Length && lines[i].Trim().StartsWith('>'); i++) quote.Add(lines[i].Trim()[1..].TrimStart());
                i--;
                sb.Append("<blockquote>").Append(ToHtml(string.Join('\n', quote), headingShift, basePath)).Append("</blockquote>");
                continue;
            }
            if (trimmed.StartsWith('|') && i + 1 < lines.Length && TableRule().IsMatch(lines[i + 1]))
            {
                Flush();
                sb.Append("<div class=\"table\"><table><thead><tr>");
                foreach (string cell in Cells(trimmed)) sb.Append("<th>").Append(Inline(cell, basePath)).Append("</th>");
                sb.Append("</tr></thead><tbody>");
                for (i += 2; i < lines.Length && lines[i].Trim().StartsWith('|'); i++)
                {
                    sb.Append("<tr>");
                    foreach (string cell in Cells(lines[i].Trim())) sb.Append("<td>").Append(Inline(cell, basePath)).Append("</td>");
                    sb.Append("</tr>");
                }
                i--;
                sb.Append("</tbody></table></div>");
                continue;
            }
            bool bullet = Bullet().IsMatch(line), numbered = !bullet && Numbered().IsMatch(line);
            if (bullet || numbered)
            {
                Flush();
                Regex marker = bullet ? Bullet() : Numbered();
                string tag = bullet ? "ul" : "ol";
                int indent = line.Length - line.TrimStart().Length;
                // Chaque element : son texte (lignes de suite comprises), puis ses sous-listes.
                var items = new List<(StringBuilder Text, List<string> Nested)>();
                for (; i < lines.Length; i++)
                {
                    string l = lines[i];
                    int lineIndent = l.Length - l.TrimStart().Length;
                    if (l.Trim().Length == 0)
                    {
                        // Une ligne vide finit la liste, sauf si la suite est encore en retrait.
                        if (i + 1 < lines.Length && lines[i + 1].Length - lines[i + 1].TrimStart().Length > indent && lines[i + 1].Trim().Length > 0) continue;
                        break;
                    }
                    if (lineIndent <= indent + 1 && marker.Match(l) is { Success: true } m) items.Add((new StringBuilder(m.Groups[1].Value.Trim()), []));
                    else if (lineIndent > indent && items.Count > 0)
                    {
                        if (Bullet().IsMatch(l) || Numbered().IsMatch(l) || items[^1].Nested.Count > 0) items[^1].Nested.Add(l);
                        else items[^1].Text.Append(' ').Append(l.Trim());
                    }
                    else break;
                }
                i--;
                sb.Append('<').Append(tag).Append('>');
                foreach ((StringBuilder itemText, List<string> nested) in items)
                {
                    sb.Append("<li>").Append(Inline(itemText.ToString(), basePath));
                    if (nested.Count > 0)
                    {
                        int cut = nested.Min(n => n.Length - n.TrimStart().Length);
                        sb.Append(ToHtml(string.Join('\n', nested.Select(n => n[Math.Min(cut, n.Length)..])), headingShift, basePath));
                    }
                    sb.Append("</li>");
                }
                sb.Append("</").Append(tag).Append('>');
                continue;
            }
            paragraph.Add(line.EndsWith("  ", StringComparison.Ordinal) ? trimmed + "\u0003" : trimmed);
        }
        Flush();
        return sb.ToString();
    }

    private static IEnumerable<string> Cells(string row)
    {
        string r = row.Trim();
        if (r.StartsWith('|')) r = r[1..];
        if (r.EndsWith('|')) r = r[..^1];
        // Une barre dans du code (`a | b`) ne coupe pas la cellule.
        var cells = new List<string>();
        var cur = new StringBuilder();
        bool code = false;
        foreach (char c in r)
        {
            if (c == '`') code = !code;
            if (c == '|' && !code) { cells.Add(cur.ToString().Trim()); cur.Clear(); }
            else cur.Append(c);
        }
        cells.Add(cur.ToString().Trim());
        return cells;
    }

    private static string Anchor(string title)
    {
        string slug = Data.Categories.Slug(title);
        return slug.Length == 0 ? "section" : slug;
    }

    /// <summary>Le texte d'une ligne : echappe, puis code, liens, gras, italique.</summary>
    public static string Inline(string text, string basePath = "")
    {
        var codes = new List<string>();
        string s = CodeSpan().Replace(text, m => { codes.Add(m.Groups[1].Value); return $"\u0001{codes.Count - 1}\u0002"; });
        s = WebUtility.HtmlEncode(s);
        s = Link().Replace(s, m =>
        {
            string label = m.Groups[1].Value, url = WebUtility.HtmlDecode(m.Groups[2].Value);
            if (url.StartsWith("https://", StringComparison.OrdinalIgnoreCase) || url.StartsWith("http://", StringComparison.OrdinalIgnoreCase))
                return $"<a href=\"{WebUtility.HtmlEncode(url)}\" rel=\"nofollow noopener\">{label}</a>";
            if (url.StartsWith('#')) return $"<a href=\"{WebUtility.HtmlEncode(url)}\">{label}</a>";
            if (url.StartsWith('/') && !url.StartsWith("//", StringComparison.Ordinal)) return $"<a href=\"{WebUtility.HtmlEncode(basePath + url)}\">{label}</a>";
            return label;
        });
        s = Bold().Replace(s, "<strong>$1</strong>");
        s = Italic().Replace(s, m => $"<em>{(m.Groups[1].Success ? m.Groups[1].Value : m.Groups[2].Value)}</em>");
        return Regex.Replace(s, "\u0001(\\d+)\u0002", m => $"<code>{WebUtility.HtmlEncode(codes[int.Parse(m.Groups[1].Value)])}</code>");
    }
}
