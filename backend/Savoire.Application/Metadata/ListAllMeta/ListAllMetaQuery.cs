// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
using MediatR;
using Savoire.Application.Common;

namespace Savoire.Application.Metadata.ListAllMeta;

/// <summary>Returns all indexed document metadata for a vault — used for audit/debug.</summary>
public record ListAllMetaQuery(string VaultId, string CallerId, bool IncludeDerived = true)
    : IRequest<IReadOnlyList<DocumentMetaDto>>;
