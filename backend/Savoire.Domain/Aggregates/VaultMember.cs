// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
using Savoire.Domain.Enums;

namespace Savoire.Domain.Aggregates;

public record VaultMember(
    string    VaultId,
    string    UserId,
    VaultRole Role,
    DateTime  JoinedAt
);
