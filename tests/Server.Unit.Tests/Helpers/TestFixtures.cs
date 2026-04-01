// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// Helpers de test — factories de données de test réutilisables.

using Savoire.Server.Models;

namespace Savoire.Server.Unit.Tests.Helpers;

public static class TestFixtures
{
    public static VaultRecord AnyVault(string ownerId = "test-user") => new(
        Id:        Guid.NewGuid().ToString(),
        Name:      "Test Vault",
        OwnerId:   ownerId,
        CreatedAt: DateTime.UtcNow
    );

    public static DocumentRecord AnyDocument(string vaultId, string path = "note.md") => new(
        Id:        Guid.NewGuid().ToString(),
        VaultId:   vaultId,
        Path:      path,
        Title:     "Test Note",
        SizeBytes: 100,
        Hash:      "sha256-test",
        CreatedAt: DateTime.UtcNow,
        UpdatedAt: DateTime.UtcNow,
        DeletedAt: null
    );

    public static FolderRecord AnyFolder(string vaultId, string path = "Notes") => new(
        Id:        Guid.NewGuid().ToString(),
        VaultId:   vaultId,
        Path:      path,
        CreatedAt: DateTime.UtcNow
    );

    public static VaultMember AnyMember(string vaultId, string userId, string role = "editor") => new(
        VaultId:  vaultId,
        UserId:   userId,
        Role:     role,
        JoinedAt: DateTime.UtcNow
    );
}
