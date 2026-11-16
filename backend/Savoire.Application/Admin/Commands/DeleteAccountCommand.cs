// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// Supprimer un compte : par la personne elle-meme (DELETE /api/v1/me) ou par
// un administrateur. Tout ce qui est a elle part : ses vaults (pour tous
// leurs membres), ses droits ailleurs, ses jetons, son compte chez le
// fournisseur d'identite. Rien n'est recuperable.
using MediatR;
using Savoire.Application.Abstractions;
using Savoire.Application.Notifications;
using Savoire.Application.Sharing;
using Savoire.Domain.Exceptions;
using Savoire.Domain.ReadModels;

namespace Savoire.Application.Admin.Commands;

public sealed record DeleteAccountCommand(string UserId) : IRequest;

public sealed class DeleteAccountCommandHandler(IAccountEraser eraser, IPublisher publisher)
    : IRequestHandler<DeleteAccountCommand>
{
    public async Task Handle(DeleteAccountCommand cmd, CancellationToken ct)
    {
        if (ShareLinkGuard.IsShareLinkCaller(cmd.UserId) || ShareLinkGuard.IsViewCaller(cmd.UserId))
            throw new AccessDeniedException("Un lien de partage n'est pas un compte.");
        AccountErasure done = await eraser.EraseAsync(cmd.UserId, ct);
        // Les sessions ouvertes sur ces vaults constatent le changement.
        foreach (string vaultId in done.DeletedVaultIds.Concat(done.LeftVaultIds))
            await publisher.Publish(new VaultMembershipChangedNotification(vaultId), ct);
        await publisher.Publish(new AccountAccessChangedNotification(cmd.UserId), ct);
    }
}

/// <summary>Restes de vaults supprimes : les compter (dryRun) ou les effacer. Administrateur seulement.</summary>
public sealed record PurgeOrphansCommand(bool DryRun) : IRequest<OrphanReport>;

public sealed class PurgeOrphansCommandHandler(IOrphanPurger purger) : IRequestHandler<PurgeOrphansCommand, OrphanReport>
{
    public Task<OrphanReport> Handle(PurgeOrphansCommand cmd, CancellationToken ct) => purger.PurgeOrphansAsync(cmd.DryRun, ct);
}
