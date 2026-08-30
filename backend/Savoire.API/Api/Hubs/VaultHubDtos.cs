// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
namespace Savoire.Server.Hubs;

public sealed record PushIndexOpDto(
    string VaultId,
    string DocId,
    string Path,
    string MarkdownContent);

public sealed record IndexOpAppliedEvent(
    long   Seq,
    string DocId,
    string Path,
    string MarkdownContent);
