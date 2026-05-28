// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
using MediatR;
using Microsoft.AspNetCore.Identity;
using Savoire.Domain.Entities;

namespace Savoire.Application.Users.GetIdentityKey;

public sealed record GetIdentityKeyQuery(string UserId) : IRequest<IdentityKeyDto>;

public sealed record IdentityKeyDto(string PrivateKey);

public sealed class GetIdentityKeyQueryHandler(UserManager<AppUser> userManager)
    : IRequestHandler<GetIdentityKeyQuery, IdentityKeyDto>
{
    public async Task<IdentityKeyDto> Handle(GetIdentityKeyQuery request, CancellationToken ct)
    {
        var user = await userManager.FindByIdAsync(request.UserId)
            ?? throw new InvalidOperationException($"User {request.UserId} not found.");

        if (string.IsNullOrEmpty(user.PrivateKeyHex))
        {
            var keyBytes = System.Security.Cryptography.RandomNumberGenerator.GetBytes(32);
            user.PrivateKeyHex = Convert.ToHexString(keyBytes).ToLowerInvariant();
            await userManager.UpdateAsync(user);
        }

        return new IdentityKeyDto(user.PrivateKeyHex);
    }
}
