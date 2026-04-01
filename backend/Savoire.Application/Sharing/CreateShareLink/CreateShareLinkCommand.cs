// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
using MediatR;
using Savoire.Application.Common;

namespace Savoire.Application.Sharing.CreateShareLink;

public record CreateShareLinkCommand(
    string    CallerId,
    string    ResourceType,
    string    ResourceId,
    string    Permission,   // "read" | "write"
    DateTime? ExpiresAt
) : IRequest<ShareLinkDto>;
