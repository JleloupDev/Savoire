// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
using MediatR;
using Savoire.Application.Common;

namespace Savoire.Application.Sync.Access;

/// <summary>
/// Verifie seulement un droit sur un vault : le controle est fait par
/// VaultAccessBehavior, le handler n'a rien d'autre a faire. Sert aux methodes
/// de hub qui ne lisent ni n'ecrivent de donnees persistees (verrous,
/// presence, relais) mais ne doivent pas etre ouvertes a tout compte.
/// </summary>
public sealed record CheckVaultAccessQuery(string CallerId, string VaultId, VaultAccessLevel RequiredAccess)
    : IRequest, IRequiresVaultAccess;

public sealed class CheckVaultAccessQueryHandler : IRequestHandler<CheckVaultAccessQuery>
{
    public Task Handle(CheckVaultAccessQuery request, CancellationToken ct) => Task.CompletedTask;
}
