// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
using MediatR;
using Savoire.Application.Common;

namespace Savoire.Application.Sync.HubPushOperation;

public record HubPushOperationCommand(
    string CallerId,
    string VaultId,
    string DocId,
    string ClientId,
    byte[] OpBytes) : IRequest, IRequiresDocumentAccess
{
    public VaultAccessLevel RequiredAccess => VaultAccessLevel.Write;
}
