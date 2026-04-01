// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
using MediatR;
using Savoire.Application.Common;

namespace Savoire.Application.Folders.RenameFolder;

public record RenameFolderCommand(string CallerId, string VaultId, string FolderId, string NewPath)
    : IRequest<FolderMoveResultDto>, IRequiresVaultAccess
{
    public VaultAccessLevel RequiredAccess => VaultAccessLevel.Write;
}
