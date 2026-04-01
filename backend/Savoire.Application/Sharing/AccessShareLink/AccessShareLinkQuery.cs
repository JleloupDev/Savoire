// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
using MediatR;
using Savoire.Application.Common;

namespace Savoire.Application.Sharing.AccessShareLink;

/// <summary>
/// Échange un token de lien de partage contre un JWT scoped.
/// </summary>
public record AccessShareLinkQuery(string Token) : IRequest<ShareLinkAccessDto>;
