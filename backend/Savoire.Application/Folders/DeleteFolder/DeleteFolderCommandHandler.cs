// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
using MediatR;
using Savoire.Domain.Aggregates;
using Savoire.Domain.Exceptions;
using Savoire.Domain.Repositories;

namespace Savoire.Application.Folders.DeleteFolder;

public class DeleteFolderCommandHandler(IFolderRepository folders)
    : IRequestHandler<DeleteFolderCommand>
{
    public async Task Handle(DeleteFolderCommand cmd, CancellationToken ct)
    {
        // Access check delegated to VaultAccessBehavior (RequiredAccess = Write).

        Folder? folder = await folders.GetByIdAsync(cmd.FolderId, ct);
        if (folder is null || folder.VaultId != cmd.VaultId) throw new FolderNotFoundException(cmd.FolderId);

        if (!cmd.Force && await folders.HasDocumentsAsync(cmd.VaultId, folder.Path, ct))
            throw new FolderNotEmptyException(cmd.FolderId);

        await folders.DeleteRecursiveAsync(cmd.FolderId, DateTime.UtcNow, ct);
    }
}
