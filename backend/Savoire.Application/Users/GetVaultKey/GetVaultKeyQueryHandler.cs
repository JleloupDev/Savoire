// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// S2 (serveur custodial) pour K_User -- voir docs/Architecture/security-channel-model.md
// section 1.3. Distinct de VaultKeyWrapController (S3, par-vault, serveur aveugle) : ici
// le serveur genere et detient K_User en clair, exactement comme
// GetIdentityKeyQueryHandler le fait deja pour la cle de signature (S2 accepte,
// memoire projet). Un compte qui n'a jamais choisi ce mode ne doit jamais
// declencher ce GET depuis le client (voir ServerVaultKeyProvider.ts).
using MediatR;
using Microsoft.AspNetCore.Identity;
using Savoire.Domain.Entities;

namespace Savoire.Application.Users.GetVaultKey;

public sealed record GetVaultKeyQuery(string UserId) : IRequest<VaultKeyDto>;

public sealed record VaultKeyDto(string VaultKey);

public sealed class GetVaultKeyQueryHandler(UserManager<AppUser> userManager)
    : IRequestHandler<GetVaultKeyQuery, VaultKeyDto>
{
    public async Task<VaultKeyDto> Handle(GetVaultKeyQuery request, CancellationToken ct)
    {
        var user = await userManager.FindByIdAsync(request.UserId)
            ?? throw new InvalidOperationException($"User {request.UserId} not found.");

        if (string.IsNullOrEmpty(user.VaultKeyHex))
        {
            var keyBytes = System.Security.Cryptography.RandomNumberGenerator.GetBytes(32);
            user.VaultKeyHex = Convert.ToHexString(keyBytes).ToLowerInvariant();
            await userManager.UpdateAsync(user);
        }

        return new VaultKeyDto(user.VaultKeyHex);
    }
}
