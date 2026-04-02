// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// Domain exceptions — moved from server/Models/Exceptions.cs
// DomainExceptionHandler in Api maps them to RFC 7807 Problem Details.

namespace Savoire.Domain.Exceptions;

public class VaultNotFoundException(string vaultId)
    : Exception($"Le vault '{vaultId}' n'existe pas ou vous n'y avez pas accès.");

public class DocumentNotFoundException(string docId)
    : Exception($"Le document '{docId}' n'existe pas.");

public class FolderNotFoundException(string folderId)
    : Exception($"Le dossier '{folderId}' n'existe pas.");

public class AccessDeniedException(string detail)
    : Exception(detail);

public class PathConflictException(string path)
    : Exception($"Le chemin '{path}' est déjà utilisé.");

public class FolderNotEmptyException(string folderId)
    : Exception($"Le dossier '{folderId}' contient des documents. Utilisez ?force=true pour forcer la suppression.");
