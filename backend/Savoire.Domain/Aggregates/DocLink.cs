// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// Lien entre documents — maintenu via l'index de backlinks.
// Extrait du contenu Markdown (ou shadow doc) à chaque mise à jour.

namespace Savoire.Domain.Aggregates;

public sealed class DocLink
{
    public string  Id         { get; private set; } = null!;
    public string  SourceId   { get; private set; } = null!; // UUID document source
    public string  VaultId    { get; private set; } = null!;
    public string? TargetId   { get; private set; }           // null si lien non résolu
    public string  TargetPath { get; private set; } = null!; // path au moment de l'écriture
    public string  LinkType   { get; private set; } = "wikilink"; // "wikilink" | "embed"

    private DocLink() { }

    public static DocLink Create(
        string sourceId, string vaultId,
        string targetPath, string? targetId,
        string linkType = "wikilink") => new()
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
        string? targetId, string targetPath, string linkType) => new()
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
