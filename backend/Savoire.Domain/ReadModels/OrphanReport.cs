// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
namespace Savoire.Domain.ReadModels;

/// <summary>Restes de vaults supprimes : lignes par table, dossiers de fichiers et leur taille.</summary>
public sealed record OrphanReport(bool DryRun, IReadOnlyDictionary<string, long> Rows, int FileFolders, long FileBytes);
