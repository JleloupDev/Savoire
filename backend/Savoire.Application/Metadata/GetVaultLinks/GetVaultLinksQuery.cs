// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
using MediatR;
using Savoire.Application.Common;

namespace Savoire.Application.Metadata.GetVaultLinks;

/// <summary>Returns all vault links with resolved source paths — used to initialize the client graph.</summary>
public record GetVaultLinksQuery(string VaultId, string CallerId)
    : IRequest<IReadOnlyList<VaultLinkDto>>;
