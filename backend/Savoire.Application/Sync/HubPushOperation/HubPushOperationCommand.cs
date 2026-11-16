// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
using MediatR;
using Savoire.Application.Common;
using Savoire.Application.Abstractions;

namespace Savoire.Application.Sync.HubPushOperation;

public sealed record HubPushOperationCommand(
    string CallerId,
    string VaultId,
    string DocId,
    string ClientId,
    byte[] OpBytes) : IRequest, IRequiresDocumentAccess, IConsumesVaultStorage
{
    public VaultAccessLevel RequiredAccess => VaultAccessLevel.Write;
    public long StorageBytes => OpBytes.Length;
}
