// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
using MediatR;
using Savoire.Application.Common;

namespace Savoire.Application.Documents.RenameDocument;

public sealed record RenameDocumentCommand(string CallerId, string VaultId, string DocId, string NewPath)
    : IRequest<DocumentDto>;
