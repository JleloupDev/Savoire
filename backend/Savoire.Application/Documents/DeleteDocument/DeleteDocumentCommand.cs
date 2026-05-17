// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
using MediatR;

namespace Savoire.Application.Documents.DeleteDocument;

public sealed record DeleteDocumentCommand(string CallerId, string VaultId, string DocId) : IRequest;
