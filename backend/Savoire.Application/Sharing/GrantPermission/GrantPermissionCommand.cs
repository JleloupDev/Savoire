// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
using MediatR;
using Savoire.Application.Common;

namespace Savoire.Application.Sharing.GrantPermission;

/// <param name="CallerId">User granting the permission (must be owner/admin).</param>
/// <param name="ResourceType">"vault" or "document".</param>
/// <param name="ResourceId">ID of the resource.</param>
/// <param name="TargetUserId">User receiving the permission.</param>
/// <param name="Permission">"read", "write" or "admin".</param>
public record GrantPermissionCommand(
    string    CallerId,
    string    ResourceType,
    string    ResourceId,
    string    TargetUserId,
    string    Permission,
    DateTime? ExpiresAt
) : IRequest<ResourcePermissionDto>;
