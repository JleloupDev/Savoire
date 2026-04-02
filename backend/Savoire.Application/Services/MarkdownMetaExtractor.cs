// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// Extracts metadata from a Markdown document:
// - YAML frontmatter (between --- and ---)
// - tags (#tag in the body or tags: field in the frontmatter)
// - wikilinks ([[path]] and ![[path]])
//

using System.Text.Json;
using System.Text.RegularExpressions;

namespace Savoire.Application.Services;

public record MarkdownExtractResult(
    string[]                       Tags,
    string                         FrontmatterJson,
    IReadOnlyList<WikilinkExtract> Wikilinks
);

public record WikilinkExtract(string TargetPath, string LinkType);

public static class MarkdownMetaExtractor
{
    private static readonly Regex WikilinkRx =
        new(@"(!?)\[\[([^\[\]|#\n]+?)(?:\|[^\]]+)?\]\]", RegexOptions.Compiled);

    private static readonly Regex InlineTagRx =
        new(@"(?<!\S)#([A-Za-z][A-Za-z0-9_/-]*)", RegexOptions.Compiled);

    public static MarkdownExtractResult Extract(string markdownContent)
    {
        var (frontmatter, body, _) = SplitFrontmatter(markdownContent);
        var tags      = ExtractTags(frontmatter, body);
        var fmJson    = SerializeFrontmatter(frontmatter);
        var wikilinks = ExtractWikilinks(body);
        return new MarkdownExtractResult(tags, fmJson, wikilinks);
    }

    private static (Dictionary<string, object?> fm, string body, string raw) SplitFrontmatter(string content)
    {
        var fm = new Dictionary<string, object?>();
        if (!content.StartsWith("---")) return (fm, content, "");

        var end = content.IndexOf("\n---", 3);
        if (end < 0) return (fm, content, "");

        var raw  = content[3..end].Trim();
        var body = content[(end + 4)..].TrimStart('\n', '\r');

        foreach (var line in raw.Split('\n'))
        {
            var colon = line.IndexOf(':');
            if (colon < 0) continue;
            var key = line[..colon].Trim();
            var val = line[(colon + 1)..].Trim();
            if (string.IsNullOrEmpty(key)) continue;

            if (val.StartsWith('[') && val.EndsWith(']'))
            {
                var items = val[1..^1].Split(',').Select(s => s.Trim().Trim('"').Trim('\''))
                    .Where(s => s.Length > 0).ToArray();
                fm[key] = items;
            }
            else
            {
                fm[key] = val;
            }
        }

        return (fm, body, raw);
    }

    private static string[] ExtractTags(Dictionary<string, object?> fm, string body)
    {
        var tags = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        if (fm.TryGetValue("tags", out var fmTags))
        {
            if (fmTags is string[] arr) foreach (var t in arr) tags.Add(t.TrimStart('#'));
            else if (fmTags is string s)  tags.Add(s.TrimStart('#'));
        }

        foreach (Match m in InlineTagRx.Matches(body))
            tags.Add(m.Groups[1].Value);

        return [.. tags];
    }

    private static IReadOnlyList<WikilinkExtract> ExtractWikilinks(string body)
    {
        var results = new List<WikilinkExtract>();
        foreach (Match m in WikilinkRx.Matches(body))
        {
            var isEmbed = m.Groups[1].Value == "!";
            var path    = m.Groups[2].Value.Trim();
            results.Add(new WikilinkExtract(path, isEmbed ? "embed" : "wikilink"));
        }
        return results;
    }

    private static string SerializeFrontmatter(Dictionary<string, object?> fm)
    {
        if (fm.Count == 0) return "{}";
        var plain = fm.ToDictionary(
            k => k.Key,
            v => v.Value is string[] arr ? (object)arr : (v.Value ?? "")
        );
        return JsonSerializer.Serialize(plain);
    }
}
