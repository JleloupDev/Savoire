// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
using MediatR;
using Savoire.Application.Common;
using Savoire.Domain.Aggregates;
using Savoire.Domain.Enums;
using Savoire.Domain.Repositories;
using Savoire.Domain.Services;
using Savoire.Domain.ValueObjects;

namespace Savoire.Application.Vaults.ListVaults;

public class ListVaultsQueryHandler(
    IVaultRepository vaults,
    IResourcePermissionRepository permissions,
    IDocumentRepository documents,
    IUserLookupService users)
    : IRequestHandler<ListVaultsQuery, WorkspaceDto>
{
    public async Task<WorkspaceDto> Handle(ListVaultsQuery query, CancellationToken ct)
    {
        var vaultItems = await vaults.GetForUserAsync(query.UserId, ct);

        var vaultSummaries = new List<VaultSummaryDto>(vaultItems.Count);
        foreach ((Vault vault, VaultRole role) in vaultItems)
        {
            VaultStats stats = await vaults.GetStatsAsync(vault.Id, ct);
            vaultSummaries.Add(ToSummary(vault, role.ToApiString(), stats));
        }

        var sharedNotes = await BuildSharedWithMeAsync(query.UserId, ct);

        return new WorkspaceDto(vaultSummaries, sharedNotes);
    }

    private async Task<IReadOnlyList<SharedNoteDto>> BuildSharedWithMeAsync(
        string userId, CancellationToken ct)
    {
        IReadOnlyList<ResourcePermission> perms = await permissions.ListForSubjectAsync(
            SubjectType.User, userId, ct);

        var docPerms = perms
            .Where(p => p.ResourceType == ResourceType.Document && !p.IsExpired())
            .ToList();

        if (docPerms.Count == 0) return [];

        var result = new List<SharedNoteDto>(docPerms.Count);
        foreach (ResourcePermission perm in docPerms)
        {
            Document? doc = await documents.GetByIdAsync(perm.ResourceId, ct);
            if (doc is null || doc.DeletedAt.HasValue) continue;

            UserInfo? grantor = await users.GetByIdAsync(perm.GrantedBy, ct);
            result.Add(new SharedNoteDto(
                DocumentId:          doc.Id,
                VaultId:             doc.VaultId,
                Path:                doc.Path,
                Permission:          perm.Permission.ToApiString(),
                GrantedByDisplayName: grantor?.DisplayName ?? perm.GrantedBy
            ));
        }
        return result;
    }

    private static VaultSummaryDto ToSummary(Vault vault, string role, VaultStats stats) =>
        new(vault.Id, vault.Name, role, stats.DocumentCount, stats.FolderCount,
            stats.LastModifiedAt, stats.SizeBytes);
}
