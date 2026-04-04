// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// Link between documents — maintained via the backlink index.
// Extracted from Markdown content (or shadow doc) on every update.
using Savoire.Domain.Enums;

namespace Savoire.Domain.Aggregates;

public sealed class DocLink
{
    public string   Id         { get; private set; } = null!;
    public string   SourceId   { get; private set; } = null!; // source document UUID
    public string   VaultId    { get; private set; } = null!;
    public string?  TargetId   { get; private set; }           // null if link is unresolved
    public string   TargetPath { get; private set; } = null!; // path at write time
    public LinkType LinkType   { get; private set; }

    private DocLink() { }

    public static DocLink Create(
        string sourceId, string vaultId,
        string targetPath, string? targetId,
        LinkType linkType = LinkType.Wikilink) => new()
    {
        Id         = Guid.NewGuid().ToString(),
        SourceId   = sourceId,
        VaultId    = vaultId,
        TargetId   = targetId,
        TargetPath = targetPath,
        LinkType   = linkType,
    };

    // FOR_PERSISTENCE_ONLY
    public static DocLink Rehydrate(
        string id, string sourceId, string vaultId,
        string? targetId, string targetPath, LinkType linkType) => new()
    {
        Id         = id,
        SourceId   = sourceId,
        VaultId    = vaultId,
        TargetId   = targetId,
        TargetPath = targetPath,
        LinkType   = linkType,
    };

    public void Resolve(string targetId)  => TargetId = targetId;
    public void Unresolve()               => TargetId = null;
}
