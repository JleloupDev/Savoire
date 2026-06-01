// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
using System.Text;
using MediatR;
using Savoire.Application.Abstractions;
using Savoire.Application.Sharing;
using Savoire.Domain.Repositories;

namespace Savoire.Application.Documents.PutDocumentContent;

public sealed class PutDocumentContentCommandHandler(
    IShareLinkRepository shareLinks,
    IContentStore        contentStore)
    : IRequestHandler<PutDocumentContentCommand>
{
    public async Task Handle(PutDocumentContentCommand cmd, CancellationToken ct)
    {
        if (ShareLinkGuard.IsShareLinkCaller(cmd.CallerId) || ShareLinkGuard.IsViewCaller(cmd.CallerId))
            await ShareLinkGuard.RequireDocumentWriteAsync(cmd.CallerId, cmd.VaultId, cmd.DocId, shareLinks, ct);

        await using var stream = new MemoryStream(Encoding.UTF8.GetBytes(cmd.Body));
        await contentStore.WriteDocumentAsync(cmd.VaultId, cmd.DocId, stream, ct);
    }
}
