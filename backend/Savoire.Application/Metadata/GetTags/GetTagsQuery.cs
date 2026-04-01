// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
using MediatR;

namespace Savoire.Application.Metadata.GetTags;

public record GetTagsQuery(string VaultId, string CallerId) : IRequest<IReadOnlyList<string>>;
