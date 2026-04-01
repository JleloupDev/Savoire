// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
using MediatR;
using Savoire.Application.Common;
using Savoire.Domain.Aggregates;
using Savoire.Domain.Repositories;

namespace Savoire.Application.Folders.ListFolders;

public class ListFoldersQueryHandler(IFolderRepository folders)
    : IRequestHandler<ListFoldersQuery, IReadOnlyList<FolderDto>>
{
    public async Task<IReadOnlyList<FolderDto>> Handle(ListFoldersQuery q, CancellationToken ct)
    {
        // Access check delegated to VaultAccessBehavior (RequiredAccess = Read).
        IReadOnlyList<Folder> list = await folders.ListAsync(q.VaultId, ct);
        return list.Select(FolderDto.FromDomain).ToList();
    }
}
