// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
using MediatR;

namespace Savoire.Application.Sharing.RevokeShareLink;

public record RevokeShareLinkCommand(string CallerId, string LinkId) : IRequest;
