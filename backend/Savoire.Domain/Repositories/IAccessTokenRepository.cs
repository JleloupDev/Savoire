// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
using Savoire.Domain.ReadModels;

namespace Savoire.Domain.Repositories;

public interface IAccessTokenRepository
{
    Task AddAsync(AccessToken token, CancellationToken ct = default);
    Task<AccessToken?> GetByHashAsync(string tokenHash, CancellationToken ct = default);
    /// <summary>Jetons de la personne, revoques compris, du plus recent au plus ancien.</summary>
    Task<IReadOnlyList<AccessToken>> ListForUserAsync(string userId, CancellationToken ct = default);
    Task<int> CountActiveForUserAsync(string userId, DateTime now, CancellationToken ct = default);
    /// <summary>Revoque un jeton de la personne. False : inconnu (ou d'une autre personne).</summary>
    Task<bool> RevokeAsync(string id, string userId, DateTime at, CancellationToken ct = default);
    Task TouchAsync(string id, DateTime at, CancellationToken ct = default);
}
