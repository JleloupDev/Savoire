// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
using MediatR;
using Savoire.Application.Common;

namespace Savoire.Application.Sync.PushOps;

public record PushOpsCommand(
    string            CallerId,
    string            VaultId,
    string            DocId,
    PushOpsRequestDto Request
) : IRequest, IRequiresDocumentAccess
{
    public VaultAccessLevel RequiredAccess => VaultAccessLevel.Write;
}
