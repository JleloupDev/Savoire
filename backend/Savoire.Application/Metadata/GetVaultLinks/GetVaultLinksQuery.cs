// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
using MediatR;
using Savoire.Application.Common;

namespace Savoire.Application.Metadata.GetVaultLinks;

/// <summary>Retourne tous les liens du vault avec les paths source résolus — pour initialiser le graphe client.</summary>
public record GetVaultLinksQuery(string VaultId, string CallerId)
    : IRequest<IReadOnlyList<VaultLinkDto>>;
