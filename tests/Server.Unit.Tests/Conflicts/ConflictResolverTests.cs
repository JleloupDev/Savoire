// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// Tests unitaires — résolution de conflits (à implémenter en V2)
// Ces tests servent de spécification pour le ConflictResolver futur.

using FluentAssertions;
using Xunit;

namespace Savoire.Server.Unit.Tests.Conflicts;

public class ConflictResolverTests
{
    // NOTE: ConflictResolver sera implémenté en Milestone 2.
    // Ces tests définissent le comportement attendu.

    [Fact(Skip = "ConflictResolver non implémenté en V1")]
    public void Rename_DuringEdit_RenameWins()
    {
        // Un rename pendant une édition → le rename l'emporte
        // Le document garde le nouveau path mais conserve le contenu édité
        true.Should().BeTrue(); // placeholder
    }

    [Fact(Skip = "ConflictResolver non implémenté en V1")]
    public void Delete_DuringEdit_ProducesLevel4Conflict()
    {
        // Une suppression pendant une édition → conflit de niveau 4
        // L'UI reçoit un événement SyncConflict avec les deux versions
        true.Should().BeTrue(); // placeholder
    }

    [Fact(Skip = "ConflictResolver non implémenté en V1")]
    public void SimultaneousRename_ServerSideLastWriteWins()
    {
        // Deux renames simultanés → le plus récent (received_at) gagne
        true.Should().BeTrue(); // placeholder
    }

    [Fact(Skip = "ConflictResolver non implémenté en V1")]
    public void DeleteFolder_WithEditedContent_ProducesLevel4Conflict()
    {
        // Suppression de dossier pendant une édition de document enfant → conflit niveau 4
        true.Should().BeTrue(); // placeholder
    }
}
