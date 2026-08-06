// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
using Savoire.Domain.Exceptions;

namespace Savoire.Domain.Aggregates;

public sealed class Vault
{
    public string   Id        { get; private set; } = null!;
    public string   Name      { get; private set; } = null!;
    public string   OwnerId   { get; private set; } = null!;
    public DateTime CreatedAt { get; private set; }
    /// <summary>S2 pour ce vault : si vrai, le serveur détient le Keyring en
    /// clair (ManagedVaultKeyringController) — jamais de K_User impliqué.
    /// Décidé une fois à la création, non convertible ensuite.</summary>
    public bool     IsManaged { get; private set; }

    // Requis par EF Core
    private Vault() { }

    public static Vault Create(string name, string ownerId, bool isManaged)
    {
        if (string.IsNullOrWhiteSpace(name))
            throw new ArgumentException("Le nom du vault ne peut pas être vide.", nameof(name));

        return new Vault
        {
            Id        = Guid.NewGuid().ToString(),
            Name      = name,
            OwnerId   = ownerId,
            CreatedAt = DateTime.UtcNow,
            IsManaged = isManaged
        };
    }

    // FOR_PERSISTENCE_ONLY: Infrastructure reconstruit des Vault depuis la DB.
    public static Vault Rehydrate(string id, string name, string ownerId, DateTime createdAt, bool isManaged) =>
        new() { Id = id, Name = name, OwnerId = ownerId, CreatedAt = createdAt, IsManaged = isManaged };

    public void Rename(string newName)
    {
        if (string.IsNullOrWhiteSpace(newName))
            throw new ArgumentException("Nouveau nom invalide.", nameof(newName));
        Name = newName;
    }

    public bool IsOwner(string userId) => OwnerId == userId;

    public void RequireOwner(string callerId)
    {
        if (!IsOwner(callerId))
            throw new AccessDeniedException("Cette opération est réservée à l'owner du vault.");
    }
}
