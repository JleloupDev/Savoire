// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
using FluentValidation;
using MediatR;
using Microsoft.Extensions.DependencyInjection;
using Savoire.Application.Auth.Commands;
using Savoire.Application.Behaviors;

namespace Savoire.Application;

public static class ApplicationServiceExtensions
{
    public static IServiceCollection AddApplicationAuth(this IServiceCollection services)
    {
        var assembly = typeof(LoginCommand).Assembly;

        services.AddMediatR(cfg =>
        {
            cfg.RegisterServicesFromAssembly(assembly);
            cfg.AddBehavior(typeof(IPipelineBehavior<,>), typeof(ValidationBehavior<,>));
        });

        services.AddValidatorsFromAssembly(assembly);

        return services;
    }
}
