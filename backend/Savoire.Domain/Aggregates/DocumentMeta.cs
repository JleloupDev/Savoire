// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// Read-model (projection) du document — extrait du contenu CRDT et des shadow docs.

namespace Savoire.Domain.Aggregates;

public sealed class DocumentMeta
{
    public string   DocumentId  { get; private set; } = null!;
    public string   VaultId     { get; private set; } = null!;
    public string   ContentType { get; private set; } = "text/markdown";

    // Null si document primaire, UUID du document source si dérivé
    public string?  DerivedFrom { get; private set; }
    // Plugin propriétaire du shadow doc (ex: "plugin-excalidraw")
    public string?  DerivedBy   { get; private set; }

    public string[] Tags        { get; private set; } = [];
    public string   Frontmatter { get; private set; } = "{}"; // JSON sérialisé
    public DateTime IndexedAt   { get; private set; }

    private DocumentMeta() { }

    public static DocumentMeta Create(
        string documentId,
        string vaultId,
        string contentType = "text/markdown",
        string? derivedFrom = null,
        string? derivedBy = null) => new()
    {
        DocumentId  = documentId,
        VaultId     = vaultId,
        ContentType = contentType,
        DerivedFrom = derivedFrom,
        DerivedBy   = derivedBy,
        Tags        = [],
        Frontmatter = "{}",
        IndexedAt   = DateTime.UtcNow,
    };

    // FOR_PERSISTENCE_ONLY
    public static DocumentMeta Rehydrate(
        string documentId, string vaultId, string contentType,
        string? derivedFrom, string? derivedBy,
        string[] tags, string frontmatter, DateTime indexedAt) => new()
    {
        DocumentId  = documentId,
        VaultId     = vaultId,
        ContentType = contentType,
        DerivedFrom = derivedFrom,
        DerivedBy   = derivedBy,
        Tags        = tags,
        Frontmatter = frontmatter,
        IndexedAt   = indexedAt,
    };

    public bool IsDerived => DerivedFrom is not null;

    public void UpdateIndex(string[] tags, string frontmatterJson)
    {
        Tags        = tags;
        Frontmatter = frontmatterJson;
        IndexedAt   = DateTime.UtcNow;
    }
}
