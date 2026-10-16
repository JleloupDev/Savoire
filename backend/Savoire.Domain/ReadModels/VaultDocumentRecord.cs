// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
namespace Savoire.Domain.ReadModels;

/// <summary>
/// Une ligne du registre « document -> vault ». ParentDocId et Name ne valent
/// que pour une piece jointe rangee dans le dossier d'une note.
/// </summary>
public sealed record VaultDocumentRecord(string DocId, string VaultId, string? ParentDocId, string? Name);
