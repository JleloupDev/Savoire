// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// Droits herites (ACL) : par defaut, un document a les droits de son dossier,
// un dossier ceux de son dossier parent, et tout le vault ceux de ses membres.
// Chaque niveau peut les surcharger :
//  - un droit donne a une personne sur un dossier ou une note l'emporte sur
//    ce qu'elle herite (le plus precis gagne), dans les deux sens : plus de
//    droit (lecteur du vault, redacteur d'un dossier) ou moins (« none » :
//    aucun acces a une note, pour un membre) ;
//  - un niveau qui n'herite plus (AclSetting.Inherit = false) ne garde que
//    les droits donnes a son niveau ou plus bas : le reste du vault n'y voit
//    plus rien.
// Le proprietaire et les administrateurs du vault gardent toujours tout :
// personne ne peut se fermer la porte du vault.
//
// Les dossiers sont ceux que le client annonce pour chaque document
// (vault_documents.folder) : le serveur ne lit pas l'arborescence CRDT. Un
// document dont le dossier n'est pas encore connu est traite comme a la racine.

using Savoire.Domain.Aggregates;
using Savoire.Domain.Enums;
using Savoire.Domain.ReadModels;
using Savoire.Domain.Repositories;

namespace Savoire.Application.Common;

/// <summary>Un droit et d'ou il vient (« vault », « folder:A/B », « document »).</summary>
public sealed record AclDecision(Permission? Permission, string Source);

public sealed class AclResolver(
    IVaultRepository vaults,
    IResourcePermissionRepository permissions,
    IVaultDocumentRepository vaultDocuments,
    IAclSettingRepository settings)
{
    /// <summary>Droit de base dans le vault : proprietaire, administrateur, membre (role), ou rien.</summary>
    public async Task<AclDecision> VaultLevelAsync(string callerId, Vault vault, CancellationToken ct)
    {
        if (vault.IsOwner(callerId)) return new AclDecision(Permission.Admin, "owner");
        ResourcePermission? grant = await permissions.GetAsync(ResourceType.Vault, vault.Id, SubjectType.User, callerId, ct);
        if (grant is not null && grant.IsExpired()) return new AclDecision(null, "vault");
        if (grant?.Permission == Permission.Admin) return new AclDecision(Permission.Admin, "vault");
        VaultMember? member = await vaults.GetMemberAsync(vault.Id, callerId, ct);
        if (member is null) return new AclDecision(null, "vault");
        return new AclDecision(member.Role == VaultRole.Viewer ? Permission.Read : Permission.Write, "vault");
    }

    /// <summary>Les niveaux d'un document, du plus precis au plus large (hors vault).</summary>
    public static IEnumerable<(ResourceType Type, string Id, string Source)> LevelsOf(string vaultId, string docId, string? folder)
    {
        yield return (ResourceType.Document, docId, "document");
        foreach (string f in FolderResource.Ancestors(folder))
            yield return (ResourceType.Folder, FolderResource.Id(vaultId, f), "folder:" + f);
    }

    /// <summary>Les niveaux d'un dossier, de lui-meme a la racine.</summary>
    public static IEnumerable<(ResourceType Type, string Id, string Source)> LevelsOfFolder(string vaultId, string folder)
    {
        foreach (string f in FolderResource.Ancestors(folder))
            yield return (ResourceType.Folder, FolderResource.Id(vaultId, f), "folder:" + f);
    }

    /// <summary>Droit effectif sur un document du vault (null : aucun acces).</summary>
    public async Task<AclDecision> ForDocumentAsync(string callerId, Vault vault, string docId, CancellationToken ct)
    {
        // Un annexe (texte extrait, commentaires...) suit son document.
        string target = AnnexDocuments.ParentOf(docId) ?? docId;
        VaultDocumentRecord? doc = await vaultDocuments.GetAsync(target, ct);
        return await ForLevelsAsync(callerId, vault, LevelsOf(vault.Id, target, doc?.Folder), ct);
    }

    /// <summary>Droit effectif sur un dossier du vault (null : aucun acces).</summary>
    public Task<AclDecision> ForFolderAsync(string callerId, Vault vault, string folder, CancellationToken ct) =>
        ForLevelsAsync(callerId, vault, LevelsOfFolder(vault.Id, folder), ct);

    /// <summary>Droit effectif en parcourant ces niveaux (du plus precis au plus large), puis le vault.</summary>
    public async Task<AclDecision> ForLevelsAsync(string callerId, Vault vault, IEnumerable<(ResourceType Type, string Id, string Source)> levels, CancellationToken ct)
    {
        AclDecision vaultLevel = await VaultLevelAsync(callerId, vault, ct);
        // Proprietaire et administrateurs : toujours tout.
        if (vaultLevel.Permission == Permission.Admin) return vaultLevel;
        foreach ((ResourceType type, string id, string source) in levels)
        {
            ResourcePermission? entry = await permissions.GetAsync(type, id, SubjectType.User, callerId, ct);
            if (entry is not null && !entry.IsExpired())
                return new AclDecision(entry.Permission == Permission.None ? null : entry.Permission, source);
            AclSetting? setting = await settings.GetAsync(type, id, ct);
            if (setting is { Inherit: false }) return new AclDecision(null, source);
        }
        return vaultLevel;
    }
}
