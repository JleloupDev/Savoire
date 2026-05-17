// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
using MediatR;
using Savoire.Application.Common;

namespace Savoire.Application.Sharing.AccessShareLink;

/// <summary>
/// Exchanges a share link token for a scoped JWT.
/// </summary>
public sealed record AccessShareLinkQuery(string Token) : IRequest<ShareLinkAccessDto>;
