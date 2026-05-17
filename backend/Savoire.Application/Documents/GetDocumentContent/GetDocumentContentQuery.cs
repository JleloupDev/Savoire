// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
using MediatR;
using Savoire.Application.Common;

namespace Savoire.Application.Documents.GetDocumentContent;

public sealed record GetDocumentContentQuery(string CallerId, string VaultId, string DocId)
    : IRequest<Stream>, IRequiresDocumentAccess
{
    public VaultAccessLevel RequiredAccess => VaultAccessLevel.Read;
}
