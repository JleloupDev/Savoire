// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Pieces jointes d'un vault (images). Chaque operation passe par
// VaultAccessBehavior : lire exige le droit de lecture sur le vault, ecrire
// ou supprimer le droit d'ecriture. Avant, la lecture etait anonyme et
// l'ecriture ouverte a tout compte connecte, quel que soit le vault.
using FluentValidation;
using MediatR;
using Savoire.Application.Abstractions;
using Savoire.Application.Common;
using Savoire.Domain.Exceptions;
using Savoire.Domain.ReadModels;
using Savoire.Domain.Repositories;

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
    : IRequest<Stream?>, IRequiresAttachmentAccess
{
    public VaultAccessLevel RequiredAccess => VaultAccessLevel.Read;
    public string AttachmentId => StoragePath;
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

/// <summary>
/// Annonce le rangement d'une piece jointe : la note dont le dossier la
/// contient (null : rangee ailleurs, par exemple `attachments/`) et son nom
/// affiche. Le serveur ne lit pas les chemins (repertoire CRDT) : c'est le
/// client qui le dit, a l'envoi et a chaque deplacement. Exige le droit
/// d'ecrire, et que la piece jointe ET la note soient inscrites dans CE vault.
/// Sert seulement au partage d'une note (lecture de ses images).
/// </summary>
public sealed record PlaceAttachmentCommand(
    string VaultId,
    string FileId,
    string? NoteId,
    string? Name,
    string CallerId
) : IRequest, IRequiresVaultAccess
{
    public VaultAccessLevel RequiredAccess => VaultAccessLevel.Write;
}

public sealed class PlaceAttachmentCommandHandler(IVaultDocumentRepository vaultDocuments)
    : IRequestHandler<PlaceAttachmentCommand>
{
    public async Task Handle(PlaceAttachmentCommand cmd, CancellationToken ct)
    {
        if (cmd.Name is { } name && (name.Length > 255 || name.Contains('/')))
            throw new ValidationException("Nom de piece jointe invalide.");
        if (cmd.NoteId == cmd.FileId)
            throw new ValidationException("Une piece jointe ne se range pas sous elle-meme.");

        VaultDocumentRecord? file = await vaultDocuments.GetAsync(cmd.FileId, ct);
        if (file is null || file.VaultId != cmd.VaultId)
            throw new AccessDeniedException("Piece jointe inconnue dans ce vault.");
        if (cmd.NoteId is not null)
        {
            VaultDocumentRecord? note = await vaultDocuments.GetAsync(cmd.NoteId, ct);
            if (note is null || note.VaultId != cmd.VaultId)
                throw new AccessDeniedException("Note inconnue dans ce vault.");
        }
        await vaultDocuments.SetPlacementAsync(cmd.FileId, cmd.NoteId, cmd.Name, ct);
    }
}

/// <summary>Une piece jointe rangee dans le dossier d'une note.</summary>
public sealed record NoteAttachmentDto(string Id, string? Name);

/// <summary>
/// Pieces jointes rangees dans le dossier d'une note : ce qu'il faut a la
/// page de partage pour afficher `![[Photo.png]]`. Exige le droit de lire la
/// note (un lien de partage vers cette note suffit).
/// </summary>
public sealed record ListNoteAttachmentsQuery(string VaultId, string DocId, string CallerId)
    : IRequest<IReadOnlyList<NoteAttachmentDto>>, IRequiresDocumentAccess
{
    public VaultAccessLevel RequiredAccess => VaultAccessLevel.Read;
}

public sealed class ListNoteAttachmentsQueryHandler(IVaultDocumentRepository vaultDocuments)
    : IRequestHandler<ListNoteAttachmentsQuery, IReadOnlyList<NoteAttachmentDto>>
{
    public async Task<IReadOnlyList<NoteAttachmentDto>> Handle(ListNoteAttachmentsQuery q, CancellationToken ct)
    {
        IReadOnlyList<VaultDocumentRecord> children = await vaultDocuments.ListChildrenAsync(q.VaultId, q.DocId, ct);
        return children.Select(c => new NoteAttachmentDto(c.DocId, c.Name)).ToList();
    }
}
