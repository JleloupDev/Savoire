// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
using MediatR;
using Savoire.Application.Common;

namespace Savoire.Application.Documents.PutDocumentContent;

public sealed record PutDocumentContentCommand(string CallerId, string VaultId, string DocId, string Body)
    : IRequest<DocumentDto>, IRequiresVaultAccess
{
    public VaultAccessLevel RequiredAccess => VaultAccessLevel.Write;
}
