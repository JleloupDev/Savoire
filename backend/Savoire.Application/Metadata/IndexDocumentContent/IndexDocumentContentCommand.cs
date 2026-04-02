// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
using MediatR;

namespace Savoire.Application.Metadata.IndexDocumentContent;

/// <summary>
/// Indexes a document's content: extracts tags, frontmatter, wikilinks
/// and updates the DocumentMeta and DocLink projections.
/// Called from SyncHub after receiving a CRDT op, or from the REST
/// controller after a content PUT.
/// </summary>
public record IndexDocumentContentCommand(
    string DocId,
    string VaultId,
    string MarkdownContent,
    // Null for a primary document. If set → derived document (shadow doc).
    string? DerivedFrom = null,
    string? DerivedBy   = null,
    string  ContentType = "text/markdown"
) : IRequest;
