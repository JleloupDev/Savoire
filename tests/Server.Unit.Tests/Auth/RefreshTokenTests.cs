// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// Tests unitaires — RefreshToken (règles métier encapsulées)

using FluentAssertions;
using Savoire.Domain.Entities;

namespace Savoire.Server.Unit.Tests.Auth;

public class RefreshTokenTests
{
    [Fact]
    public void IsExpired_WhenExpiresAtInPast_ReturnsTrue()
    {
        var token = new RefreshToken { ExpiresAt = DateTime.UtcNow.AddDays(-1) };
        token.IsExpired.Should().BeTrue();
    }

    [Fact]
    public void IsExpired_WhenExpiresAtInFuture_ReturnsFalse()
    {
        var token = new RefreshToken { ExpiresAt = DateTime.UtcNow.AddDays(7) };
        token.IsExpired.Should().BeFalse();
    }

    [Fact]
    public void IsRevoked_WhenRevokedAtIsSet_ReturnsTrue()
    {
        var token = new RefreshToken { RevokedAt = DateTime.UtcNow };
        token.IsRevoked.Should().BeTrue();
    }

    [Fact]
    public void IsRevoked_WhenRevokedAtIsNull_ReturnsFalse()
    {
        var token = new RefreshToken { RevokedAt = null };
        token.IsRevoked.Should().BeFalse();
    }

    [Fact]
    public void IsActive_WhenNotRevokedAndNotExpired_ReturnsTrue()
    {
        var token = new RefreshToken
        {
            ExpiresAt = DateTime.UtcNow.AddDays(7),
            RevokedAt = null
        };
        token.IsActive.Should().BeTrue();
    }

    [Fact]
    public void IsActive_WhenRevoked_ReturnsFalse()
    {
        var token = new RefreshToken
        {
            ExpiresAt = DateTime.UtcNow.AddDays(7),
            RevokedAt = DateTime.UtcNow
        };
        token.IsActive.Should().BeFalse();
    }

    [Fact]
    public void IsActive_WhenExpired_ReturnsFalse()
    {
        var token = new RefreshToken
        {
            ExpiresAt = DateTime.UtcNow.AddDays(-1),
            RevokedAt = null
        };
        token.IsActive.Should().BeFalse();
    }
}
