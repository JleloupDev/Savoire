// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// Tests unitaires — ShareLink (règles métier encapsulées)

using FluentAssertions;
using Savoire.Domain.Aggregates;

namespace Savoire.Server.Unit.Tests.Sharing;

public class ShareLinkTests
{
    // ── Create ────────────────────────────────────────────────────────────────

    [Fact]
    public void Create_SetsAllProperties()
    {
        var link = ShareLink.Create("vault", "v1", "read", "user-1");

        link.Id.Should().NotBeNullOrEmpty();
        link.Token.Should().NotBeNullOrEmpty();
        link.ResourceType.Should().Be("vault");
        link.ResourceId.Should().Be("v1");
        link.Permission.Should().Be("read");
        link.CreatedBy.Should().Be("user-1");
        link.ExpiresAt.Should().BeNull();
        link.RevokedAt.Should().BeNull();
        link.CreatedAt.Should().BeCloseTo(DateTime.UtcNow, TimeSpan.FromSeconds(2));
    }

    [Fact]
    public void Create_TokenIsUrlSafeBase64()
    {
        var link = ShareLink.Create("vault", "v1", "read", "user-1");

        // URL-safe base64 : pas de +, /, =
        link.Token.Should().NotContainAny("+", "/", "=");
        link.Token.Length.Should().Be(43); // 32 bytes → 43 chars URL-safe base64
    }

    [Fact]
    public void Create_TwoLinks_HaveDifferentTokens()
    {
        var link1 = ShareLink.Create("vault", "v1", "read", "user-1");
        var link2 = ShareLink.Create("vault", "v1", "read", "user-1");

        link1.Token.Should().NotBe(link2.Token);
        link1.Id.Should().NotBe(link2.Id);
    }

    // ── IsValid ───────────────────────────────────────────────────────────────

    [Fact]
    public void IsValid_WhenNoExpiryAndNotRevoked_ReturnsTrue()
    {
        var link = ShareLink.Create("vault", "v1", "read", "user-1");
        link.IsValid().Should().BeTrue();
    }

    [Fact]
    public void IsValid_WhenExpiresInFuture_ReturnsTrue()
    {
        var link = ShareLink.Create("vault", "v1", "read", "user-1",
            expiresAt: DateTime.UtcNow.AddHours(24));
        link.IsValid().Should().BeTrue();
    }

    [Fact]
    public void IsValid_WhenExpired_ReturnsFalse()
    {
        var link = ShareLink.Rehydrate(
            Guid.NewGuid().ToString(), "tok", "vault", "v1",
            "read", "user-1", DateTime.UtcNow.AddDays(-2),
            expiresAt: DateTime.UtcNow.AddDays(-1), revokedAt: null);

        link.IsValid().Should().BeFalse();
    }

    [Fact]
    public void IsValid_WhenRevoked_ReturnsFalse()
    {
        var link = ShareLink.Create("vault", "v1", "read", "user-1");
        link.Revoke();
        link.IsValid().Should().BeFalse();
    }

    [Fact]
    public void IsValid_WhenRevokedAndExpired_ReturnsFalse()
    {
        var link = ShareLink.Rehydrate(
            Guid.NewGuid().ToString(), "tok", "vault", "v1",
            "read", "user-1", DateTime.UtcNow.AddDays(-2),
            expiresAt: DateTime.UtcNow.AddDays(-1), revokedAt: DateTime.UtcNow.AddDays(-1));

        link.IsValid().Should().BeFalse();
    }

    // ── AllowsWrite ───────────────────────────────────────────────────────────

    [Fact]
    public void AllowsWrite_WhenWritePermissionAndValid_ReturnsTrue()
    {
        var link = ShareLink.Create("document", "doc-1", "write", "user-1");
        link.AllowsWrite().Should().BeTrue();
    }

    [Fact]
    public void AllowsWrite_WhenReadPermission_ReturnsFalse()
    {
        var link = ShareLink.Create("document", "doc-1", "read", "user-1");
        link.AllowsWrite().Should().BeFalse();
    }

    [Fact]
    public void AllowsWrite_WhenWriteButRevoked_ReturnsFalse()
    {
        var link = ShareLink.Create("document", "doc-1", "write", "user-1");
        link.Revoke();
        link.AllowsWrite().Should().BeFalse();
    }

    // ── Revoke ────────────────────────────────────────────────────────────────

    [Fact]
    public void Revoke_SetsRevokedAt()
    {
        var link = ShareLink.Create("vault", "v1", "read", "user-1");
        link.Revoke();

        link.RevokedAt.Should().NotBeNull();
        link.RevokedAt!.Value.Should().BeCloseTo(DateTime.UtcNow, TimeSpan.FromSeconds(2));
    }

    // ── Rehydrate ─────────────────────────────────────────────────────────────

    [Fact]
    public void Rehydrate_PreservesAllProperties()
    {
        var id        = Guid.NewGuid().ToString();
        var token     = "some-url-safe-token";
        var createdAt = DateTime.UtcNow.AddDays(-1);
        var expiresAt = DateTime.UtcNow.AddDays(6);
        var revokedAt = (DateTime?)null;

        var link = ShareLink.Rehydrate(id, token, "document", "doc-99",
            "write", "author", createdAt, expiresAt, revokedAt);

        link.Id.Should().Be(id);
        link.Token.Should().Be(token);
        link.ResourceType.Should().Be("document");
        link.ResourceId.Should().Be("doc-99");
        link.Permission.Should().Be("write");
        link.CreatedBy.Should().Be("author");
        link.CreatedAt.Should().Be(createdAt);
        link.ExpiresAt.Should().Be(expiresAt);
        link.RevokedAt.Should().BeNull();
    }
}
