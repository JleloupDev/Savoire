// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
using MediatR;

using Savoire.Application.Common;
using Savoire.Application.Abstractions;

namespace Savoire.Application.Sync.PushVaultOperation;

public sealed record PushVaultOperationCommand(string CallerId, string VaultId, byte[] OpBytes)
    : IRequest, IRequiresVaultAccess, IConsumesVaultStorage
{
    public VaultAccessLevel RequiredAccess => VaultAccessLevel.Write;
    public long StorageBytes => OpBytes.Length;
}
