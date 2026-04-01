// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
namespace Savoire.Domain.ValueObjects;

public record VaultStats(
    int       DocumentCount,
    int       FolderCount,
    DateTime? LastModifiedAt,
    long      SizeBytes
);
