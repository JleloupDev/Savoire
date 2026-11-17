// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// Droits herites et surcharges (voir AclResolver) : lire et modifier les
// droits d'un dossier ou d'un document. Reserve au proprietaire et aux
// administrateurs du vault. Chaque changement fait reverifier les connexions
// ouvertes du vault (VaultMembershipChangedNotification -> HubSubscriptions).
//
// Le dossier d'un document est annonce par le client (PlaceDocumentsCommand) ;
// un dossier renomme emporte ses droits (RenameAclFolderCommand).

using FluentValidation;
using FluentValidation.Results;
using MediatR;
using Savoire.Application.Common;
using Savoire.Application.Notifications;
using Savoire.Domain.Aggregates;
using Savoire.Domain.Enums;
using Savoire.Domain.Exceptions;
using Savoire.Domain.ReadModels;
using Savoire.Domain.Repositories;
using Savoire.Domain.Services;

namespace Savoire.Application.Sharing.Acl;

/// <summary>Un droit donne a ce niveau.</summary>
public sealed record AclEntryDto(string SubjectId, string? DisplayName, string Permission, DateTime? ExpiresAt);

/// <summary>Un droit qui vient d'au-dessus (vault, dossier parent).</summary>
public sealed record AclInheritedDto(string SubjectId, string? DisplayName, string Permission, string Source);

/// <summary>Les droits d'un dossier ou d'un document.</summary>
public sealed record AclViewDto(
    string Level, string? DocId, string? Folder, bool Inherit,
    IReadOnlyList<AclEntryDto> Entries, IReadOnlyList<AclInheritedDto> Inherited);

/// <summary>Un dossier ou un document du vault : exactement l'un des deux.</summary>
public sealed record AclTarget(string VaultId, string? DocId, string? Folder);

internal static class AclTargets
{
    public static (ResourceType Type, string Id, string? Folder) Resolve(AclTarget t)
    {
        if (t.DocId is { Length: > 0 } && t.Folder is null) return (ResourceType.Document, t.DocId, null);
        if (t.DocId is null && t.Folder is not null)
        {
            string folder = FolderResource.Normalize(t.Folder) is { Length: > 0 } f
                ? f : throw new ValidationException([new ValidationFailure("folder", "Dossier invalide.")]);
            return (ResourceType.Folder, FolderResource.Id(t.VaultId, folder), folder);
        }
        throw new ValidationException([new ValidationFailure("target", "Donner docId OU folder.")]);
    }

    /// <summary>Gerer les droits : proprietaire ou administrateur du vault ; le document doit etre dans ce vault.</summary>
    public static async Task<Vault> RequireManageAsync(
        string callerId, AclTarget t, IVaultRepository vaults, IResourcePermissionRepository permissions,
        IVaultDocumentRepository vaultDocuments, CancellationToken ct)
    {
        if (ShareLinkGuard.IsShareLinkCaller(callerId) || ShareLinkGuard.IsViewCaller(callerId))
            throw new AccessDeniedException("Un lien de partage ne gere pas les droits.");
        if (t.DocId is not null && await vaultDocuments.GetVaultIdAsync(t.DocId, ct) != t.VaultId)
            throw new DocumentNotInVaultException(t.VaultId);
        await GrantPermission.GrantPermissionCommandHandler.RequireShareRightAsync(
            callerId, ResourceType.Vault, t.VaultId, vaults, permissions, vaultDocuments, ct);
        return await vaults.GetByIdAsync(t.VaultId, ct) ?? throw new VaultNotFoundException(t.VaultId);
    }
}

// ── Lire ───────────────────────────────────────────────────────────────────

public sealed record GetAclQuery(string CallerId, AclTarget Target) : IRequest<AclViewDto>;

public sealed class GetAclQueryHandler(
    IVaultRepository vaults, IResourcePermissionRepository permissions, IVaultDocumentRepository vaultDocuments,
    IAclSettingRepository settings, AclResolver acl, IUserLookupService users) : IRequestHandler<GetAclQuery, AclViewDto>
{
    public async Task<AclViewDto> Handle(GetAclQuery q, CancellationToken ct)
    {
        Vault vault = await AclTargets.RequireManageAsync(q.CallerId, q.Target, vaults, permissions, vaultDocuments, ct);
        (ResourceType type, string id, string? folder) = AclTargets.Resolve(q.Target);
        AclSetting? setting = await settings.GetAsync(type, id, ct);

        async Task<string?> Name(string userId) => (await users.GetByIdAsync(userId, ct))?.DisplayName;

        var entries = new List<AclEntryDto>();
        foreach (ResourcePermission p in await permissions.ListForResourceAsync(type, id, ct))
            if (!p.IsExpired()) entries.Add(new AclEntryDto(p.SubjectId, await Name(p.SubjectId), p.Permission.ToApiString(), p.ExpiresAt));

        // Ce qui vient d'au-dessus : le niveau sans lui-meme. Pour qui ? Le
        // proprietaire, les membres, et ceux qui ont un droit sur un dossier parent.
        string? parentFolder = type == ResourceType.Document
            ? (await vaultDocuments.GetAsync(q.Target.DocId!, ct))?.Folder
            : ParentOf(folder!);
        var parents = AclResolver.LevelsOfFolder(vault.Id, parentFolder ?? "").ToList();
        var subjects = new HashSet<string> { vault.OwnerId };
        foreach (VaultMember m in await vaults.GetMembersAsync(vault.Id, ct)) subjects.Add(m.UserId);
        foreach ((ResourceType pt, string pid, _) in parents)
            foreach (ResourcePermission p in await permissions.ListForResourceAsync(pt, pid, ct)) subjects.Add(p.SubjectId);

        // Montre meme quand ce niveau n'herite plus : la personne voit ce qu'elle a coupe.
        var inherited = new List<AclInheritedDto>();
        foreach (string subject in subjects)
        {
            AclDecision d = await acl.ForLevelsAsync(subject, vault, parents, ct);
            if (d.Permission is { } perm) inherited.Add(new AclInheritedDto(subject, await Name(subject), perm.ToApiString(), d.Source));
        }
        return new AclViewDto(type == ResourceType.Document ? "document" : "folder", q.Target.DocId, folder,
            setting is not { Inherit: false }, entries, inherited.OrderBy(i => i.DisplayName).ToList());
    }

    private static string ParentOf(string folder)
    {
        int slash = folder.LastIndexOf('/');
        return slash < 0 ? "" : folder[..slash];
    }
}

// ── Heritage ───────────────────────────────────────────────────────────────

public sealed record SetAclInheritCommand(string CallerId, AclTarget Target, bool Inherit) : IRequest;

public sealed class SetAclInheritCommandHandler(
    IVaultRepository vaults, IResourcePermissionRepository permissions, IVaultDocumentRepository vaultDocuments,
    IAclSettingRepository settings, IPublisher publisher) : IRequestHandler<SetAclInheritCommand>
{
    public async Task Handle(SetAclInheritCommand cmd, CancellationToken ct)
    {
        await AclTargets.RequireManageAsync(cmd.CallerId, cmd.Target, vaults, permissions, vaultDocuments, ct);
        (ResourceType type, string id, _) = AclTargets.Resolve(cmd.Target);
        await settings.SetAsync(type, id, cmd.Target.VaultId, cmd.Inherit, cmd.CallerId, ct);
        await publisher.Publish(new VaultMembershipChangedNotification(cmd.Target.VaultId), ct);
    }
}

// ── Droits donnes a ce niveau ──────────────────────────────────────────────

public sealed record SetAclEntryCommand(string CallerId, AclTarget Target, string SubjectId, string Permission, DateTime? ExpiresAt) : IRequest;

public sealed class SetAclEntryCommandHandler(
    IVaultRepository vaults, IResourcePermissionRepository permissions, IVaultDocumentRepository vaultDocuments,
    IUserLookupService users, IPublisher publisher) : IRequestHandler<SetAclEntryCommand>
{
    public async Task Handle(SetAclEntryCommand cmd, CancellationToken ct)
    {
        Vault vault = await AclTargets.RequireManageAsync(cmd.CallerId, cmd.Target, vaults, permissions, vaultDocuments, ct);
        (ResourceType type, string id, _) = AclTargets.Resolve(cmd.Target);
        Permission permission = cmd.Permission.ParsePermission();
        if (cmd.SubjectId == vault.OwnerId)
            throw new ValidationException([new ValidationFailure("subjectId", "Le proprietaire du vault garde tous les droits.")]);
        if (await users.GetByIdAsync(cmd.SubjectId, ct) is null) throw new UserNotFoundException(cmd.SubjectId);
        if (await permissions.GetAsync(type, id, SubjectType.User, cmd.SubjectId, ct) is { } existing)
            await permissions.DeleteAsync(existing.Id, ct);
        await permissions.AddAsync(ResourcePermission.Create(type, id, SubjectType.User, cmd.SubjectId, permission, cmd.CallerId, cmd.ExpiresAt), ct);
        await publisher.Publish(new VaultMembershipChangedNotification(cmd.Target.VaultId), ct);
    }
}

public sealed record RemoveAclEntryCommand(string CallerId, AclTarget Target, string SubjectId) : IRequest;

public sealed class RemoveAclEntryCommandHandler(
    IVaultRepository vaults, IResourcePermissionRepository permissions, IVaultDocumentRepository vaultDocuments,
    IPublisher publisher) : IRequestHandler<RemoveAclEntryCommand>
{
    public async Task Handle(RemoveAclEntryCommand cmd, CancellationToken ct)
    {
        await AclTargets.RequireManageAsync(cmd.CallerId, cmd.Target, vaults, permissions, vaultDocuments, ct);
        (ResourceType type, string id, _) = AclTargets.Resolve(cmd.Target);
        if (await permissions.GetAsync(type, id, SubjectType.User, cmd.SubjectId, ct) is { } existing)
            await permissions.DeleteAsync(existing.Id, ct);
        await publisher.Publish(new VaultMembershipChangedNotification(cmd.Target.VaultId), ct);
    }
}

// ── Dossier renomme ────────────────────────────────────────────────────────

/// <summary>Un dossier renomme ou deplace : ses droits et ceux de son contenu suivent. Redacteurs du vault.</summary>
public sealed record RenameAclFolderCommand(string CallerId, string VaultId, string From, string To) : IRequest, IRequiresVaultAccess
{
    public VaultAccessLevel RequiredAccess => VaultAccessLevel.Write;
}

public sealed class RenameAclFolderCommandHandler(
    IVaultRepository vaults, AclResolver acl, IAclSettingRepository settings, IPublisher publisher) : IRequestHandler<RenameAclFolderCommand>
{
    public async Task Handle(RenameAclFolderCommand cmd, CancellationToken ct)
    {
        string from = FolderResource.Normalize(cmd.From) is { Length: > 0 } f ? f : throw new ValidationException([new ValidationFailure("from", "Dossier invalide.")]);
        string to = FolderResource.Normalize(cmd.To) is { Length: > 0 } t ? t : throw new ValidationException([new ValidationFailure("to", "Dossier invalide.")]);
        if (from == to) return;
        Vault vault = await vaults.GetByIdAsync(cmd.VaultId, ct) ?? throw new VaultNotFoundException(cmd.VaultId);
        // Il faut pouvoir ecrire dans le dossier ou il est, et la ou il va :
        // sinon deplacer servirait a sortir un dossier de ses restrictions.
        foreach (string folder in new[] { from, to })
            if ((await acl.ForFolderAsync(cmd.CallerId, vault, folder, ct)).Permission is not (Permission.Write or Permission.Admin))
                throw new AccessDeniedException("Droit d'ecriture requis sur le dossier.");
        await settings.RenameFolderAsync(cmd.VaultId, from, to, ct);
        await publisher.Publish(new VaultMembershipChangedNotification(cmd.VaultId), ct);
    }
}

// ── Dossier de chaque document (annonce par le client) ─────────────────────

public sealed record DocumentFolderDto(string DocId, string Folder);

/// <summary>
/// Le client annonce le dossier de documents (creation, deplacement). Rend les
/// documents refuses : hors du vault, ou que l'appelant ne peut pas ecrire la
/// ou ils sont, ou la ou il les met (sinon deplacer contournerait un droit).
/// </summary>
public sealed record PlaceDocumentsCommand(string CallerId, string VaultId, IReadOnlyList<DocumentFolderDto> Documents)
    : IRequest<IReadOnlyList<string>>, IRequiresVaultAccess
{
    public VaultAccessLevel RequiredAccess => VaultAccessLevel.Write;
}

public sealed class PlaceDocumentsCommandHandler(
    IVaultRepository vaults, IVaultDocumentRepository vaultDocuments, AclResolver acl, IPublisher publisher)
    : IRequestHandler<PlaceDocumentsCommand, IReadOnlyList<string>>
{
    public const int MaxDocuments = 500;

    public async Task<IReadOnlyList<string>> Handle(PlaceDocumentsCommand cmd, CancellationToken ct)
    {
        if (cmd.Documents.Count > MaxDocuments)
            throw new ValidationException([new ValidationFailure("documents", $"{MaxDocuments} documents au plus par envoi.")]);
        Vault vault = await vaults.GetByIdAsync(cmd.VaultId, ct) ?? throw new VaultNotFoundException(cmd.VaultId);
        var rejected = new List<string>();
        bool changed = false;
        foreach (DocumentFolderDto d in cmd.Documents)
        {
            VaultDocumentRecord? doc = await vaultDocuments.GetAsync(d.DocId, ct);
            string? folder = FolderResource.Normalize(d.Folder);
            if (doc is null || doc.VaultId != cmd.VaultId || folder is null) { rejected.Add(d.DocId); continue; }
            if (doc.Folder == folder) continue;
            bool canHere = (await acl.ForDocumentAsync(cmd.CallerId, vault, d.DocId, ct)).Permission is Permission.Write or Permission.Admin;
            bool canThere = folder.Length == 0
                ? (await acl.VaultLevelAsync(cmd.CallerId, vault, ct)).Permission is Permission.Write or Permission.Admin
                : (await acl.ForFolderAsync(cmd.CallerId, vault, folder, ct)).Permission is Permission.Write or Permission.Admin;
            if (!canHere || !canThere) { rejected.Add(d.DocId); continue; }
            await vaultDocuments.SetFolderAsync(d.DocId, folder, ct);
            changed = true;
        }
        if (changed) await publisher.Publish(new VaultMembershipChangedNotification(cmd.VaultId), ct);
        return rejected;
    }
}
