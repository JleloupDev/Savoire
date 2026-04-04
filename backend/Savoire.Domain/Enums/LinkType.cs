// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
namespace Savoire.Domain.Enums;

/// <summary>Type of inter-document link extracted from Markdown content.</summary>
public enum LinkType
{
    /// <summary>Standard wiki link: [[path]]</summary>
    Wikilink,
    /// <summary>Embedded content: ![[path]]</summary>
    Embed
}

public static class LinkTypeExtensions
{
    public static string ToApiString(this LinkType lt) => lt switch
    {
        LinkType.Wikilink => "wikilink",
        LinkType.Embed    => "embed",
        _                 => throw new ArgumentOutOfRangeException(nameof(lt), lt, null)
    };

    public static LinkType ParseLinkType(this string s) => s switch
    {
        "wikilink" => LinkType.Wikilink,
        "embed"    => LinkType.Embed,
        _          => throw new ArgumentException($"Unknown LinkType: '{s}'")
    };
}
