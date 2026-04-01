// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
using MediatR;
using Savoire.Application.Common;

namespace Savoire.Application.ViewGrants.RedeemViewGrant;

public record RedeemViewGrantCommand(string GrantToken) : IRequest<ViewAccessDto>;
