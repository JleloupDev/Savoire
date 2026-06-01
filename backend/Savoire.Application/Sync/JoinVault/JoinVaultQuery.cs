// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
using MediatR;

namespace Savoire.Application.Sync.JoinVault;

public record JoinVaultResult(string[] Ops);

public sealed record JoinVaultQuery(string CallerId, string VaultId)
    : IRequest<JoinVaultResult>;
