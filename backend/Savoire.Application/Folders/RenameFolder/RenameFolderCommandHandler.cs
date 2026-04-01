// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
using MediatR;
using Savoire.Application.Common;
using Savoire.Domain.Aggregates;
using Savoire.Domain.Exceptions;
using Savoire.Domain.Repositories;

namespace Savoire.Application.Folders.RenameFolder;

public class RenameFolderCommandHandler(IFolderRepository folders)
    : IRequestHandler<RenameFolderCommand, FolderMoveResultDto>
{
    public async Task<FolderMoveResultDto> Handle(RenameFolderCommand cmd, CancellationToken ct)
    {
        // Access check delegated to VaultAccessBehavior (RequiredAccess = Write).

        Folder? folder = await folders.GetByIdAsync(cmd.FolderId, ct);
        if (folder is null || folder.VaultId != cmd.VaultId) throw new FolderNotFoundException(cmd.FolderId);

        if (await folders.GetByPathAsync(cmd.VaultId, cmd.NewPath, ct) is not null)
            throw new PathConflictException(cmd.NewPath);

        (int movedFolders, int movedDocs) = await folders.MoveAsync(cmd.FolderId, cmd.NewPath, ct);
        return new FolderMoveResultDto(movedDocs, movedFolders);
    }
}
