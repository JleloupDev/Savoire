// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
using MediatR;
using Savoire.Application.Common;

namespace Savoire.Application.Metadata.GetBacklinks;

public record GetBacklinksQuery(string VaultId, string DocId, string CallerId) : IRequest<IReadOnlyList<BacklinkDto>>;
