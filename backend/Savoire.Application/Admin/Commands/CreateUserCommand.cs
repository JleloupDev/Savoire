// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
using MediatR;
using Microsoft.AspNetCore.Identity;
using Savoire.Application.Auth.DTOs;
using Savoire.Application.Auth.Mappers;
using Savoire.Domain.Entities;
using Savoire.Domain.Exceptions;

namespace Savoire.Application.Admin.Commands;

public record CreateUserCommand(
    string Email,
    string Password,
    string DisplayName,
    bool IsAdmin = false) : IRequest<AuthUserDto>;

public class CreateUserCommandHandler(
    UserManager<AppUser> userManager) :
    IRequestHandler<CreateUserCommand, AuthUserDto>
{
    public async Task<AuthUserDto> Handle(
        CreateUserCommand request, CancellationToken ct)
    {
        if (await userManager.FindByEmailAsync(request.Email) is not null)
            throw new EmailAlreadyUsedException(request.Email);

        var user = new AppUser
        {
            UserName = request.Email,
            Email = request.Email,
            DisplayName = request.DisplayName,
            IsAdmin = request.IsAdmin,
            EmailConfirmed = true
        };

        var result = await userManager.CreateAsync(user, request.Password);
        if (!result.Succeeded)
            throw new IdentityOperationException(result.Errors);

        return UserMapper.ToDto(user);
    }
}
