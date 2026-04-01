// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
using MediatR;
using Savoire.Application.Common;

namespace Savoire.Application.Sync.HubSnapshotDocument;

public record HubSnapshotDocumentCommand(
    string CallerId,
    string VaultId,
    string DocId,
    byte[] SnapshotBytes) : IRequest, IRequiresVaultAccess
{
    public VaultAccessLevel RequiredAccess => VaultAccessLevel.Read;
}
