// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
using MediatR;
using Savoire.Application.Common;

namespace Savoire.Application.ViewGrants.CreateViewGrant;

public record CreateViewGrantCommand(
    string? CallerId,
    string? ShareToken,
    string? VaultId,
    string? DocId,
    string? Path,
    string? RequestedPermission
) : IRequest<ViewGrantDto>;
