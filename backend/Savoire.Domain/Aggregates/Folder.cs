// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
namespace Savoire.Domain.Aggregates;

public sealed class Folder
{
    public string   Id        { get; private set; } = null!;
    public string   VaultId   { get; private set; } = null!;
    public string   Path      { get; private set; } = null!;
    public DateTime CreatedAt { get; private set; }

    private Folder() { }

    public static Folder Create(string vaultId, string path) => new()
    {
        Id        = Guid.NewGuid().ToString(),
        VaultId   = vaultId,
        Path      = path,
        CreatedAt = DateTime.UtcNow
    };

    // FOR_PERSISTENCE_ONLY
    public static Folder Rehydrate(string id, string vaultId, string path, DateTime createdAt) =>
        new() { Id = id, VaultId = vaultId, Path = path, CreatedAt = createdAt };
}
