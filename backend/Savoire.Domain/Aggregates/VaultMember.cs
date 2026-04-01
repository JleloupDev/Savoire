// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
namespace Savoire.Domain.Aggregates;

public record VaultMember(
    string   VaultId,
    string   UserId,
    string   Role,       // "owner" | "editor" | "viewer"
    DateTime JoinedAt
);
