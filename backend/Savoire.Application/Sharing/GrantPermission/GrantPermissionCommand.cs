// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
using MediatR;
using Savoire.Application.Common;

namespace Savoire.Application.Sharing.GrantPermission;

/// <param name="CallerId">Utilisateur qui accorde la permission (doit être owner/admin).</param>
/// <param name="ResourceType">"vault" ou "document".</param>
/// <param name="ResourceId">ID de la ressource.</param>
/// <param name="TargetUserId">Utilisateur qui reçoit la permission.</param>
/// <param name="Permission">"read", "write" ou "admin".</param>
public record GrantPermissionCommand(
    string    CallerId,
    string    ResourceType,
    string    ResourceId,
    string    TargetUserId,
    string    Permission,
    DateTime? ExpiresAt
) : IRequest<ResourcePermissionDto>;
