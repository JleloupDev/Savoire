// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// MediatR notifications publiées par les handlers de documents.
// see ADR-001

using MediatR;

namespace Savoire.Application.Notifications;

public record DocumentCreatedNotification(
    string    DocId,
    string    VaultId,
    string    Path,
    string?   Title,
    DateTime  CreatedAt,
    DateTime  UpdatedAt
) : INotification;

public record DocumentRenamedNotification(
    string   DocId,
    string   VaultId,
    string   OldPath,
    string   NewPath,
    DateTime UpdatedAt
) : INotification;

public record DocumentDeletedNotification(
    string   DocId,
    string   VaultId,
    string   Path,
    DateTime DeletedAt
) : INotification;

/// <summary>
/// Publiée après que le contenu d'un document a été sauvegardé/indexé.
/// Déclenche la mise à jour des métadonnées (tags, wikilinks) dans la projection.
/// </summary>
public record DocumentContentIndexedNotification(
    string DocId,
    string VaultId,
    string MarkdownContent  // texte extrait du CRDT ou du shadow doc
) : INotification;

/// <summary>
/// Publiée après un rename — indique aux clients quels documents contiennent
/// des wikilinks vers l'ancien path et doivent être mis à jour.
/// </summary>
public record WikilinkCascadeNotification(
    string VaultId,
    string OldPath,
    string NewPath,
    IReadOnlyList<string> AffectedDocIds  // documents contenant [[OldPath]]
) : INotification;
