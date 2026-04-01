// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
using System.Text;
using MediatR;
using Savoire.Application.Common;
using Savoire.Domain.Aggregates;
using Savoire.Domain.Repositories;

namespace Savoire.Application.Folders.CreateFolder;

public class CreateFolderCommandHandler(IFolderRepository folders)
    : IRequestHandler<CreateFolderCommand, FolderDto>
{
    public async Task<FolderDto> Handle(CreateFolderCommand cmd, CancellationToken ct)
    {
        // Access check delegated to VaultAccessBehavior (RequiredAccess = Write).
        Folder leaf = await EnsureFolderPathAsync(cmd.VaultId, cmd.Path, ct);
        return FolderDto.FromDomain(leaf);
    }

    private async Task<Folder> EnsureFolderPathAsync(string vaultId, string path, CancellationToken ct)
    {
        string[] segments = path.Split('/', StringSplitOptions.RemoveEmptyEntries);
        Folder? last = null;
        var current = new StringBuilder();

        foreach (string segment in segments)
        {
            if (current.Length > 0) current.Append('/');
            current.Append(segment);
            string segPath = current.ToString();

            Folder? existing = await folders.GetByPathAsync(vaultId, segPath, ct);
            if (existing is not null) { last = existing; continue; }

            Folder folder = Folder.Create(vaultId, segPath);
            await folders.AddAsync(folder, ct);
            last = folder;
        }

        return last ?? throw new ArgumentException("Chemin vide", nameof(path));
    }
}
