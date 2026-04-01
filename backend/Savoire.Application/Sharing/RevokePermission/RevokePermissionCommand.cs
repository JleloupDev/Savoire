// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
using MediatR;

namespace Savoire.Application.Sharing.RevokePermission;

public record RevokePermissionCommand(
    string CallerId,
    string ResourceType,
    string ResourceId,
    string TargetUserId
) : IRequest;
