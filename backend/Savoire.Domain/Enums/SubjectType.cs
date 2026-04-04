// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
namespace Savoire.Domain.Enums;

/// <summary>
/// Type of ACL subject. Currently only User is implemented;
/// Group and Role are reserved for future multi-tenancy.
/// </summary>
public enum SubjectType
{
    User
}

public static class SubjectTypeExtensions
{
    public static string ToApiString(this SubjectType st) => st switch
    {
        SubjectType.User => "user",
        _                => throw new ArgumentOutOfRangeException(nameof(st), st, null)
    };

    public static SubjectType ParseSubjectType(this string s) => s switch
    {
        "user" => SubjectType.User,
        _      => throw new ArgumentException($"Unknown SubjectType: '{s}'")
    };
}
