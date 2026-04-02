// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
namespace Savoire.Domain.ReadModels;

/// <summary>Lightweight vault link projection — used to initialize the client-side graph.</summary>
public record VaultLinkProjection(
    string  SourceId,
    string  SourcePath,
    string? TargetId,
    string  TargetPath,
    string  LinkType
);
