// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
using Microsoft.AspNetCore.Identity;

namespace Savoire.Domain.Entities;

public class AppUser : IdentityUser
{
    public string DisplayName { get; set; } = string.Empty;
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime? LastLoginAt { get; set; }
    public bool IsAdmin { get; set; } = false;
    /// <summary>Ed25519 private key (32 bytes) stored as hex. Generated on first key request.</summary>
    // TODO(P3): encrypt at rest before enabling P2P verification — plain-text private key is acceptable only while the server is the sole trusted party.
    public string? PrivateKeyHex { get; set; }

    /// <summary>K_User (32 bytes) stored as hex. Generated lazily on the first
    /// GET /api/v1/vault-key — only for an account that explicitly chose the
    /// "let the server manage my key" mode (S2). See VaultKeyEscrow.ts for the
    /// default S3 mode, where the server never sees K_User in clear.</summary>
    // TODO(P3): encrypt at rest — same reservation as PrivateKeyHex above.
    public string? VaultKeyHex { get; set; }
}
