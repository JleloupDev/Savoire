// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
using MediatR;
using Savoire.Application.Common;

namespace Savoire.Application.Sync.SyncDocument;

public record SyncDocumentCommand(
    string         CallerId,
    string         VaultId,
    string         DocId,
    SyncRequestDto Request
) : IRequest<SyncResponseDto>, IRequiresDocumentAccess
{
    public VaultAccessLevel RequiredAccess => VaultAccessLevel.Read;
}
