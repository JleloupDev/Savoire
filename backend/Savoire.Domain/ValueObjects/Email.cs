// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
using Savoire.Domain.Exceptions;

namespace Savoire.Domain.ValueObjects;

public record Email
{
    public string Value { get; }

    public Email(string value)
    {
        if (string.IsNullOrWhiteSpace(value) || !value.Contains('@'))
            throw new InvalidEmailException(value);
        Value = value.ToLowerInvariant().Trim();
    }

    public static implicit operator string(Email email) => email.Value;
    public override string ToString() => Value;
}
