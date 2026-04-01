// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
namespace Savoire.Domain.Aggregates;

public sealed class Document
{
    public string    Id        { get; private set; } = null!;
    public string    VaultId   { get; private set; } = null!;
    public string    Path      { get; private set; } = null!;
    public string?   Title     { get; private set; }
    public long      SizeBytes { get; private set; }
    public string    Hash      { get; private set; } = "";
    public DateTime  CreatedAt { get; private set; }
    public DateTime  UpdatedAt { get; private set; }
    public DateTime? DeletedAt { get; private set; }

    private Document() { }

    public static Document Create(string vaultId, string path, string? title,
                                   long sizeBytes, string hash) => new()
    {
        Id        = Guid.NewGuid().ToString(),
        VaultId   = vaultId,
        Path      = path,
        Title     = title,
        SizeBytes = sizeBytes,
        Hash      = hash,
        CreatedAt = DateTime.UtcNow,
        UpdatedAt = DateTime.UtcNow
    };

    // FOR_PERSISTENCE_ONLY
    public static Document Rehydrate(string id, string vaultId, string path, string? title,
                                        long sizeBytes, string hash,
                                        DateTime createdAt, DateTime updatedAt, DateTime? deletedAt) =>
        new()
        {
            Id = id, VaultId = vaultId, Path = path, Title = title,
            SizeBytes = sizeBytes, Hash = hash,
            CreatedAt = createdAt, UpdatedAt = updatedAt, DeletedAt = deletedAt
        };

    public void UpdateContent(string? title, long sizeBytes, string hash)
    {
        Title     = title;
        SizeBytes = sizeBytes;
        Hash      = hash;
        UpdatedAt = DateTime.UtcNow;
    }

    public void UpdateTitle(string? title)
    {
        Title     = title;
        UpdatedAt = DateTime.UtcNow;
    }

    public void Rename(string newPath)
    {
        Path      = newPath;
        UpdatedAt = DateTime.UtcNow;
    }

    public void SoftDelete()
    {
        DeletedAt = DateTime.UtcNow;
        UpdatedAt = DateTime.UtcNow;
    }
}
