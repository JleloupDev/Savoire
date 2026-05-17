// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
using MediatR;
using Savoire.Application.Common;

namespace Savoire.Application.Vaults.RenameVault;

public sealed record RenameVaultCommand(string CallerId, string VaultId, string NewName) : IRequest<VaultSummaryDto>;
