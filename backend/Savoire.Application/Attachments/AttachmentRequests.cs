// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Pieces jointes d'un vault (images). Chaque operation passe par
// VaultAccessBehavior : lire exige le droit de lecture sur le vault, ecrire
// ou supprimer le droit d'ecriture. Avant, la lecture etait anonyme et
// l'ecriture ouverte a tout compte connecte, quel que soit le vault.
using MediatR;
using Savoire.Application.Abstractions;
using Savoire.Application.Common;

namespace Savoire.Application.Attachments;

/// <summary>
/// Stocke une piece jointe. Avec <see cref="FileId"/>, le fichier est range
/// sous cet identifiant (celui du document du repertoire) : le nom affiche
/// reste libre et renommable. Sans, l'ancien comportement : un nom genere.
/// Rend le chemin de stockage.
/// </summary>
public sealed record StoreAttachmentCommand(
    string VaultId,
    string? FileId,
    string FileName,
    Stream Content,
    string CallerId
) : IRequest<string>, IRequiresVaultAccess
{
    public VaultAccessLevel RequiredAccess => VaultAccessLevel.Write;
}

public sealed class StoreAttachmentCommandHandler(IContentStore store)
    : IRequestHandler<StoreAttachmentCommand, string>
{
    public async Task<string> Handle(StoreAttachmentCommand cmd, CancellationToken ct)
    {
        if (cmd.FileId is null) return await store.WriteAttachmentAsync(cmd.VaultId, cmd.FileName, cmd.Content, ct);
        await store.PutAttachmentAsync(cmd.VaultId, cmd.FileId, cmd.Content, ct);
        return cmd.FileId;
    }
}

/// <summary>Lit une piece jointe. Null si elle n'existe pas.</summary>
public sealed record ReadAttachmentQuery(string VaultId, string StoragePath, string CallerId)
    : IRequest<Stream?>, IRequiresVaultAccess
{
    public VaultAccessLevel RequiredAccess => VaultAccessLevel.Read;
}

public sealed class ReadAttachmentQueryHandler(IContentStore store)
    : IRequestHandler<ReadAttachmentQuery, Stream?>
{
    public Task<Stream?> Handle(ReadAttachmentQuery query, CancellationToken ct)
        => store.ReadAttachmentAsync(query.VaultId, query.StoragePath, ct);
}

public sealed record DeleteAttachmentCommand(string VaultId, string StoragePath, string CallerId)
    : IRequest, IRequiresVaultAccess
{
    public VaultAccessLevel RequiredAccess => VaultAccessLevel.Write;
}

public sealed class DeleteAttachmentCommandHandler(IContentStore store)
    : IRequestHandler<DeleteAttachmentCommand>
{
    public Task Handle(DeleteAttachmentCommand cmd, CancellationToken ct)
        => store.DeleteAttachmentAsync(cmd.VaultId, cmd.StoragePath, ct);
}
