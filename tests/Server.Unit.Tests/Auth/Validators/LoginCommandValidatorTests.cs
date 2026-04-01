// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// Tests unitaires — LoginCommandValidator

using FluentAssertions;
using Savoire.Application.Auth.Commands;
using Savoire.Application.Auth.Validators;

namespace Savoire.Server.Unit.Tests.Auth.Validators;

public class LoginCommandValidatorTests
{
    private readonly LoginCommandValidator _sut = new();

    [Fact]
    public void Validate_WithValidCommand_IsValid()
    {
        var cmd = new LoginCommand("user@example.com", "password123", "127.0.0.1");
        var result = _sut.Validate(cmd);
        result.IsValid.Should().BeTrue();
    }

    [Theory]
    [InlineData("")]
    [InlineData("notanemail")]
    [InlineData("missing@")]
    public void Validate_WithInvalidEmail_IsInvalid(string email)
    {
        var cmd = new LoginCommand(email, "password123", "127.0.0.1");
        var result = _sut.Validate(cmd);
        result.IsValid.Should().BeFalse();
        result.Errors.Should().Contain(e => e.PropertyName == "Email");
    }

    [Fact]
    public void Validate_WithEmptyPassword_IsInvalid()
    {
        var cmd = new LoginCommand("user@example.com", "", "127.0.0.1");
        var result = _sut.Validate(cmd);
        result.IsValid.Should().BeFalse();
        result.Errors.Should().Contain(e => e.PropertyName == "Password");
    }
}
