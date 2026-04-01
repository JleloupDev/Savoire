// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
using MediatR;
using Savoire.Application.Common;

namespace Savoire.Application.Sharing.GetResourceSharing;

public record GetResourceSharingQuery(
    string CallerId,
    string ResourceType,
    string ResourceId
) : IRequest<ResourceSharingDto>;
