// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// Tests unitaires — ResourcePermission (règles métier encapsulées)

using FluentAssertions;
using Savoire.Domain.Aggregates;

namespace Savoire.Server.Unit.Tests.Sharing;

public class ResourcePermissionTests
{
    // ── Create ────────────────────────────────────────────────────────────────

    [Fact]
    public void Create_SetsAllProperties()
    {
        var perm = ResourcePermission.Create(
            "vault", "v1", "user", "user-2", "write", "admin-1");

        perm.Id.Should().NotBeNullOrEmpty();
        perm.ResourceType.Should().Be("vault");
        perm.ResourceId.Should().Be("v1");
        perm.SubjectType.Should().Be("user");
        perm.SubjectId.Should().Be("user-2");
        perm.Permission.Should().Be("write");
        perm.GrantedBy.Should().Be("admin-1");
        perm.ExpiresAt.Should().BeNull();
        perm.GrantedAt.Should().BeCloseTo(DateTime.UtcNow, TimeSpan.FromSeconds(2));
    }

    [Fact]
    public void Create_TwoPermissions_HaveDifferentIds()
    {
        var p1 = ResourcePermission.Create("vault", "v1", "user", "u1", "read", "admin");
        var p2 = ResourcePermission.Create("vault", "v1", "user", "u2", "read", "admin");

        p1.Id.Should().NotBe(p2.Id);
    }

    // ── IsExpired ─────────────────────────────────────────────────────────────

    [Fact]
    public void IsExpired_WhenNoExpiry_ReturnsFalse()
    {
        var perm = ResourcePermission.Create("vault", "v1", "user", "u1", "read", "admin");
        perm.IsExpired().Should().BeFalse();
    }

    [Fact]
    public void IsExpired_WhenExpiresInFuture_ReturnsFalse()
    {
        var perm = ResourcePermission.Create("vault", "v1", "user", "u1", "read", "admin",
            expiresAt: DateTime.UtcNow.AddDays(7));
        perm.IsExpired().Should().BeFalse();
    }

    [Fact]
    public void IsExpired_WhenExpiresInPast_ReturnsTrue()
    {
        var perm = ResourcePermission.Rehydrate(
            Guid.NewGuid().ToString(), "vault", "v1",
            "user", "u1", "read", "admin",
            grantedAt: DateTime.UtcNow.AddDays(-10),
            expiresAt: DateTime.UtcNow.AddDays(-1));

        perm.IsExpired().Should().BeTrue();
    }

    // ── AllowsWrite ───────────────────────────────────────────────────────────

    [Theory]
    [InlineData("write")]
    [InlineData("admin")]
    public void AllowsWrite_WhenWriteOrAdmin_ReturnsTrue(string permission)
    {
        var perm = ResourcePermission.Create("vault", "v1", "user", "u1", permission, "admin");
        perm.AllowsWrite().Should().BeTrue();
    }

    [Fact]
    public void AllowsWrite_WhenRead_ReturnsFalse()
    {
        var perm = ResourcePermission.Create("vault", "v1", "user", "u1", "read", "admin");
        perm.AllowsWrite().Should().BeFalse();
    }

    // ── Rehydrate ─────────────────────────────────────────────────────────────

    [Fact]
    public void Rehydrate_PreservesAllProperties()
    {
        var id        = Guid.NewGuid().ToString();
        var grantedAt = DateTime.UtcNow.AddDays(-5);
        var expiresAt = DateTime.UtcNow.AddDays(25);

        var perm = ResourcePermission.Rehydrate(
            id, "document", "doc-1", "user", "u1",
            "admin", "owner", grantedAt, expiresAt);

        perm.Id.Should().Be(id);
        perm.ResourceType.Should().Be("document");
        perm.ResourceId.Should().Be("doc-1");
        perm.SubjectType.Should().Be("user");
        perm.SubjectId.Should().Be("u1");
        perm.Permission.Should().Be("admin");
        perm.GrantedBy.Should().Be("owner");
        perm.GrantedAt.Should().Be(grantedAt);
        perm.ExpiresAt.Should().Be(expiresAt);
    }
}
