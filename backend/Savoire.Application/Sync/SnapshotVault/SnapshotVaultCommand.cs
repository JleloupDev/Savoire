// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
using MediatR;

using Savoire.Application.Common;

namespace Savoire.Application.Sync.SnapshotVault;

public sealed record SnapshotVaultCommand(string CallerId, string VaultId, byte[] SnapshotBytes)
    : IRequest, IRequiresVaultAccess
{
    public VaultAccessLevel RequiredAccess => VaultAccessLevel.Write;
}
