// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// Tests unitaires — Email (value object)

using FluentAssertions;
using Savoire.Domain.Exceptions;
using Savoire.Domain.ValueObjects;

namespace Savoire.Server.Unit.Tests.Auth;

public class EmailValueObjectTests
{
    [Theory]
    [InlineData("user@example.com", "user@example.com")]
    [InlineData("USER@EXAMPLE.COM", "user@example.com")]
    [InlineData("  User@Example.com  ", "user@example.com")]
    public void Ctor_WithValidEmail_NormalizesLowercase(string input, string expected)
    {
        var email = new Email(input);
        email.Value.Should().Be(expected);
    }

    [Theory]
    [InlineData("notanemail")]
    [InlineData("missing-at-sign.com")]
    public void Ctor_WithoutAtSign_Throws_InvalidEmailException(string input)
    {
        var act = () => new Email(input);
        act.Should().Throw<InvalidEmailException>();
    }

    [Theory]
    [InlineData("")]
    [InlineData("   ")]
    public void Ctor_WithEmptyOrWhitespace_Throws_InvalidEmailException(string input)
    {
        var act = () => new Email(input);
        act.Should().Throw<InvalidEmailException>();
    }

    [Fact]
    public void ImplicitConversion_ToString_ReturnsValue()
    {
        var email = new Email("test@example.com");
        string value = email;
        value.Should().Be("test@example.com");
    }

    [Fact]
    public void ToString_ReturnsValue()
    {
        var email = new Email("test@example.com");
        email.ToString().Should().Be("test@example.com");
    }
}
