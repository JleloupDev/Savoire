// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// Suppression d'un compte (revue du 14/11/2026, E2 : droit a l'effacement).
//
// Ordre :
//  1. chez le fournisseur d'identite : la personne ne peut plus se connecter.
//     S'il refuse ou ne repond pas, rien n'est efface (on peut recommencer) ;
//  2. dans Savoire, en une transaction : ses vaults et tout leur contenu
//     (VaultEraser), sa place dans les vaults des autres, les droits qu'on lui
//     avait donnes, ses cles, ses jetons personnels, ses retours, son compte ;
//  3. les fichiers de ses vaults, une fois la base validee.
// Les vaults qu'elle possedait disparaissent pour tous leurs membres : un
// vault n'a pas d'autre proprietaire possible aujourd'hui.

using Microsoft.AspNetCore.Identity;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;
using Savoire.Application.Abstractions;
using Savoire.Domain.Entities;
using Savoire.Domain.Exceptions;
using Savoire.Domain.Interfaces;
using Savoire.Infrastructure.Persistence;

namespace Savoire.Infrastructure.Auth;

public sealed class AccountEraser(
    AppDbContext db,
    UserManager<AppUser> users,
    IContentStore files,
    IIdentityProviderAdmin identityProvider,
    IAccountCache accounts,
    IVaultStorageQuota quota,
    ILogger<AccountEraser> logger) : IAccountEraser
{
    public async Task<AccountErasure> EraseAsync(string userId, CancellationToken ct = default)
    {
        AppUser user = await users.FindByIdAsync(userId) ?? throw new UserNotFoundException(userId);

        if (identityProvider.Configured) await identityProvider.DeleteUserAsync(userId, ct);
        // Des maintenant : un jeton encore valide ne recree pas le compte.
        accounts.MarkDeleted(userId);

        List<string> owned = await db.Vaults.AsNoTracking().Where(v => v.OwnerId == userId).Select(v => v.Id).ToListAsync(ct);
        List<string> joined = await db.VaultMembers.AsNoTracking().Where(m => m.UserId == userId).Select(m => m.VaultId).ToListAsync(ct);

        await using (var tx = await db.Database.BeginTransactionAsync(ct))
        {
            foreach (string vaultId in owned)
            {
                await IndexerChangeWriter.RecordVaultGoneAsync(db, vaultId, purgeRows: true, ct);
                await VaultEraser.EraseRowsAsync(db, vaultId, ct);
                await db.Vaults.Where(v => v.Id == vaultId).ExecuteDeleteAsync(ct);
            }
            await db.VaultMembers.Where(m => m.UserId == userId).ExecuteDeleteAsync(ct);
            await db.ResourcePermissions.Where(p => p.SubjectType == "user" && p.SubjectId == userId).ExecuteDeleteAsync(ct);
            await db.VaultKeyWraps.Where(k => k.UserId == userId).ExecuteDeleteAsync(ct);
            await db.VaultMemberIdentities.Where(i => i.UserId == userId).ExecuteDeleteAsync(ct);
            await db.AccessTokens.Where(t => t.UserId == userId).ExecuteDeleteAsync(ct);
            await db.FeedbackReports.Where(f => f.UserId == userId).ExecuteDeleteAsync(ct);
            IdentityResult deleted = await users.DeleteAsync(user);
            if (!deleted.Succeeded)
                throw new InvalidOperationException("Compte : suppression impossible : "
                    + string.Join(", ", deleted.Errors.Select(e => e.Description)));
            await tx.CommitAsync(ct);
        }

        foreach (string vaultId in owned)
        {
            quota.Invalidate(vaultId);
            try { await files.DeleteVaultAsync(vaultId, ct); }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                // La purge des restes (administration) les retrouvera.
                logger.LogWarning(ex, "Compte supprime : fichiers du vault {VaultId} non effaces.", vaultId);
            }
        }
        accounts.MarkDeleted(userId);
        logger.LogInformation("Compte supprime : {Vaults} vault(s) efface(s), {Joined} quitte(s).", owned.Count, joined.Count);
        return new AccountErasure(owned, joined.Except(owned).ToList());
    }
}
