// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// Document read-model (projection) — extracted from CRDT content and shadow docs.

namespace Savoire.Domain.Aggregates;

public sealed class DocumentMeta
{
    public string   DocumentId  { get; private set; } = null!;
    public string   VaultId     { get; private set; } = null!;
    public string   ContentType { get; private set; } = "text/markdown";

    // Null for a primary document, source document UUID if derived
    public string?  DerivedFrom { get; private set; }
    // Plugin that owns the shadow doc (e.g. "plugin-excalidraw")
    public string?  DerivedBy   { get; private set; }

    public string[] Tags        { get; private set; } = [];
    public string   Frontmatter { get; private set; } = "{}"; // serialized JSON
    public DateTime IndexedAt   { get; private set; }

    // Links extracted from this document's content — owned by the index.
    public IReadOnlyList<DocLink> Links { get; private set; } = [];

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
        string[] tags, string frontmatter, DateTime indexedAt,
        IReadOnlyList<DocLink>? links = null) => new()
    {
        DocumentId  = documentId,
        VaultId     = vaultId,
        ContentType = contentType,
        DerivedFrom = derivedFrom,
        DerivedBy   = derivedBy,
        Tags        = tags,
        Frontmatter = frontmatter,
        IndexedAt   = indexedAt,
        Links       = links ?? [],
    };

    public bool IsDerived => DerivedFrom is not null;

    public void UpdateIndex(string[] tags, string frontmatterJson)
    {
        Tags        = tags;
        Frontmatter = frontmatterJson;
        IndexedAt   = DateTime.UtcNow;
    }

    public void SetLinks(IReadOnlyList<DocLink> links) => Links = links;
}
