// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
using MediatR;

namespace Savoire.Application.Metadata.IndexDocumentContent;

/// <summary>
/// Indexe le contenu d'un document : extrait tags, frontmatter, wikilinks
/// et met à jour les projections DocumentMeta et DocLink.
/// Appelé depuis le SyncHub après réception d'une op CRDT, ou depuis le
/// controller REST après un PUT de contenu.
/// </summary>
public record IndexDocumentContentCommand(
    string DocId,
    string VaultId,
    string MarkdownContent,
    // Null si document primaire. Si renseigné → document dérivé (shadow doc).
    string? DerivedFrom = null,
    string? DerivedBy   = null,
    string  ContentType = "text/markdown"
) : IRequest;
