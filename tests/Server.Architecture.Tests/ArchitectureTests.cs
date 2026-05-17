// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// ═══════════════════════════════════════════════════════════════════════════
// Architecture tests — FICHIER PROTÉGÉ
//
// Ce fichier ne doit PAS être modifié sans demande explicite de l'utilisateur.
// Il encode les contraintes d'architecture de la Clean Architecture et sert
// de garde-fou automatique contre les violations de dépendances inter-couches.
//
// Couches (ordre de dépendance strict) :
//   Domain  ←  Application  ←  Infrastructure  ←  API
//
// Règles de nommage imposées par les tests :
//   - Commandes  : *Command
//   - Requêtes   : *Query
//   - Handlers   : *Handler  (implémentent IRequestHandler<,>)
//   - Validators : *Validator (héritent AbstractValidator<>)
//   - Controllers: *Controller (héritent ControllerBase)
//   - Repositories interfaces : I*Repository (dans Domain)
//   - Repositories impl       : *Repository (dans Infrastructure)
// ═══════════════════════════════════════════════════════════════════════════

using System.Reflection;
using NetArchTest.Rules;
using Xunit;

namespace Savoire.Server.Architecture.Tests;

/// <summary>
/// Points d'entrée dans chaque assembly — permettent à NetArchTest de charger
/// les assemblies sans dépendre de types internes spécifiques.
/// </summary>
internal static class Assemblies
{
    public static readonly Assembly Domain         = typeof(Savoire.Domain.Aggregates.Vault).Assembly;
    public static readonly Assembly Application    = typeof(Savoire.Application.Vaults.CreateVault.CreateVaultCommand).Assembly;
    public static readonly Assembly Infrastructure = typeof(Savoire.Infrastructure.Persistence.AppDbContext).Assembly;
    public static readonly Assembly Api            = typeof(Savoire.Server.Controllers.VaultsController).Assembly;
}

internal static class Ns
{
    public const string Domain         = "Savoire.Domain";
    public const string Application    = "Savoire.Application";
    public const string Infrastructure = "Savoire.Infrastructure";
    public const string Api            = "Savoire.Server";
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Isolation du Domain
// ─────────────────────────────────────────────────────────────────────────────

public sealed class DomainLayerTests
{
    [Fact(DisplayName = "Domain — pas de dépendance vers Application")]
    public void Domain_ShouldNotDependOn_Application()
    {
        var result = Types.InAssembly(Assemblies.Domain)
            .ShouldNot().HaveDependencyOn(Ns.Application)
            .GetResult();
        Assert.True(result.IsSuccessful, Helpers.Format(result));
    }

    [Fact(DisplayName = "Domain — pas de dépendance vers Infrastructure")]
    public void Domain_ShouldNotDependOn_Infrastructure()
    {
        var result = Types.InAssembly(Assemblies.Domain)
            .ShouldNot().HaveDependencyOn(Ns.Infrastructure)
            .GetResult();
        Assert.True(result.IsSuccessful, Helpers.Format(result));
    }

    [Fact(DisplayName = "Domain — pas de dépendance vers l'API")]
    public void Domain_ShouldNotDependOn_Api()
    {
        var result = Types.InAssembly(Assemblies.Domain)
            .ShouldNot().HaveDependencyOn(Ns.Api)
            .GetResult();
        Assert.True(result.IsSuccessful, Helpers.Format(result));
    }

    [Fact(DisplayName = "Domain — les interfaces de repositories commencent par I et finissent par Repository")]
    public void Domain_RepositoryInterfaces_NamingConvention()
    {
        var result = Types.InAssembly(Assemblies.Domain)
            .That().ResideInNamespace($"{Ns.Domain}.Repositories")
            .Should().BeInterfaces()
            .And().HaveNameStartingWith("I")
            .And().HaveNameEndingWith("Repository")
            .GetResult();
        Assert.True(result.IsSuccessful, Helpers.Format(result));
    }

    [Fact(DisplayName = "Domain — les exceptions héritent de Exception et résident dans le namespace Exceptions")]
    public void Domain_Exceptions_ResideInCorrectNamespace()
    {
        var result = Types.InAssembly(Assemblies.Domain)
            .That().Inherit(typeof(Exception))
            .Should().ResideInNamespace($"{Ns.Domain}.Exceptions")
            .GetResult();
        Assert.True(result.IsSuccessful, Helpers.Format(result));
    }

    [Fact(DisplayName = "Domain — pas de dépendance vers EntityFramework Core")]
    public void Domain_ShouldNotDependOn_EntityFramework()
    {
        var result = Types.InAssembly(Assemblies.Domain)
            .ShouldNot().HaveDependencyOn("Microsoft.EntityFrameworkCore")
            .GetResult();
        Assert.True(result.IsSuccessful, Helpers.Format(result));
    }

    [Fact(DisplayName = "Domain — les events de domaine finissent par Event")]
    public void Domain_DomainEvents_NamingConvention()
    {
        var result = Types.InAssembly(Assemblies.Domain)
            .That().ResideInNamespace($"{Ns.Domain}.Events")
            .Should().HaveNameEndingWith("Event")
            .GetResult();
        Assert.True(result.IsSuccessful, Helpers.Format(result));
    }

    [Fact(DisplayName = "Domain — les Value Objects résident dans Domain.ValueObjects")]
    public void Domain_ValueObjects_ResideInCorrectNamespace()
    {
        var result = Types.InAssembly(Assemblies.Domain)
            .That().HaveNameEndingWith("ValueObject")
            .Should().ResideInNamespace($"{Ns.Domain}.ValueObjects")
            .GetResult();
        Assert.True(result.IsSuccessful, Helpers.Format(result));
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Isolation de l'Application
// ─────────────────────────────────────────────────────────────────────────────

public sealed class ApplicationLayerTests
{
    [Fact(DisplayName = "Application — pas de dépendance vers Infrastructure")]
    public void Application_ShouldNotDependOn_Infrastructure()
    {
        var result = Types.InAssembly(Assemblies.Application)
            .ShouldNot().HaveDependencyOn(Ns.Infrastructure)
            .GetResult();
        Assert.True(result.IsSuccessful, Helpers.Format(result));
    }

    [Fact(DisplayName = "Application — pas de dépendance vers l'API")]
    public void Application_ShouldNotDependOn_Api()
    {
        var result = Types.InAssembly(Assemblies.Application)
            .ShouldNot().HaveDependencyOn(Ns.Api)
            .GetResult();
        Assert.True(result.IsSuccessful, Helpers.Format(result));
    }

    [Fact(DisplayName = "Application — les Commands finissent par Command")]
    public void Application_Commands_NamingConvention()
    {
        var result = Types.InAssembly(Assemblies.Application)
            .That().ImplementInterface(typeof(MediatR.IBaseRequest))
            .And().HaveNameEndingWith("Command")
            .Should().ResideInNamespace(Ns.Application)
            .GetResult();
        Assert.True(result.IsSuccessful, Helpers.Format(result));
    }

    [Fact(DisplayName = "Application — les Queries finissent par Query")]
    public void Application_Queries_NamingConvention()
    {
        var result = Types.InAssembly(Assemblies.Application)
            .That().ImplementInterface(typeof(MediatR.IBaseRequest))
            .And().HaveNameEndingWith("Query")
            .Should().ResideInNamespace(Ns.Application)
            .GetResult();
        Assert.True(result.IsSuccessful, Helpers.Format(result));
    }

    [Fact(DisplayName = "Application — les Validators finissent par Validator et résident dans Application")]
    public void Application_Validators_NamingConvention()
    {
        var result = Types.InAssembly(Assemblies.Application)
            .That().HaveNameEndingWith("Validator")
            .Should().ResideInNamespace(Ns.Application)
            .GetResult();
        Assert.True(result.IsSuccessful, Helpers.Format(result));
    }

    [Fact(DisplayName = "Application — les Handlers finissent par Handler et résident dans Application")]
    public void Application_Handlers_NamingConvention()
    {
        var result = Types.InAssembly(Assemblies.Application)
            .That().HaveNameEndingWith("Handler")
            .Should().ResideInNamespace(Ns.Application)
            .GetResult();
        Assert.True(result.IsSuccessful, Helpers.Format(result));
    }

    [Fact(DisplayName = "Application — les Handlers sont des classes concrètes non-abstraites")]
    public void Application_Handlers_AreConcreteClasses()
    {
        var result = Types.InAssembly(Assemblies.Application)
            .That().HaveNameEndingWith("Handler")
            .Should().BeClasses()
            .And().NotBeAbstract()
            .GetResult();
        Assert.True(result.IsSuccessful, Helpers.Format(result));
    }

    [Fact(DisplayName = "Application — les Handlers dépendent de MediatR (implémentent IRequestHandler)")]
    public void Application_Handlers_DependOnMediatR()
    {
        var result = Types.InAssembly(Assemblies.Application)
            .That().HaveNameEndingWith("Handler")
            .Should().HaveDependencyOn("MediatR")
            .GetResult();
        Assert.True(result.IsSuccessful, Helpers.Format(result));
    }

    [Fact(DisplayName = "Application — les Validators dépendent de FluentValidation")]
    public void Application_Validators_UseFluentValidation()
    {
        var result = Types.InAssembly(Assemblies.Application)
            .That().HaveNameEndingWith("Validator")
            .Should().HaveDependencyOn("FluentValidation")
            .GetResult();
        Assert.True(result.IsSuccessful, Helpers.Format(result));
    }

    [Fact(DisplayName = "Application — pas de dépendance vers EntityFramework Core")]
    public void Application_ShouldNotDependOn_EntityFramework()
    {
        var result = Types.InAssembly(Assemblies.Application)
            .ShouldNot().HaveDependencyOn("Microsoft.EntityFrameworkCore")
            .GetResult();
        Assert.True(result.IsSuccessful, Helpers.Format(result));
    }

    [Fact(DisplayName = "Application — les Commands et Queries sont des types scellés")]
    public void Application_RequestTypes_AreSealed()
    {
        var result = Types.InAssembly(Assemblies.Application)
            .That().ImplementInterface(typeof(MediatR.IBaseRequest))
            .Should().BeSealed()
            .GetResult();
        Assert.True(result.IsSuccessful, Helpers.Format(result));
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Isolation de l'Infrastructure
// ─────────────────────────────────────────────────────────────────────────────

public sealed class InfrastructureLayerTests
{
    [Fact(DisplayName = "Infrastructure — pas de dépendance vers l'API")]
    public void Infrastructure_ShouldNotDependOn_Api()
    {
        var result = Types.InAssembly(Assemblies.Infrastructure)
            .ShouldNot().HaveDependencyOn(Ns.Api)
            .GetResult();
        Assert.True(result.IsSuccessful, Helpers.Format(result));
    }

    [Fact(DisplayName = "Infrastructure — les implémentations de repositories résident dans Infrastructure")]
    public void Infrastructure_RepositoryImplementations_ResideInInfrastructure()
    {
        var result = Types.InAssembly(Assemblies.Infrastructure)
            .That().HaveNameEndingWith("Repository")
            .And().AreNotInterfaces()
            .Should().ResideInNamespace(Ns.Infrastructure)
            .GetResult();
        Assert.True(result.IsSuccessful, Helpers.Format(result));
    }

    [Fact(DisplayName = "Infrastructure — les implémentations de repositories implémentent une interface Domain")]
    public void Infrastructure_RepositoryImplementations_ImplementDomainInterface()
    {
        var domainRepoInterfaces = Types.InAssembly(Assemblies.Domain)
            .That().ResideInNamespace($"{Ns.Domain}.Repositories")
            .And().AreInterfaces()
            .GetTypes();

        var infraRepos = Types.InAssembly(Assemblies.Infrastructure)
            .That().HaveNameEndingWith("Repository")
            .And().AreNotInterfaces()
            .GetTypes();

        foreach (var repo in infraRepos)
        {
            var implements = repo.GetInterfaces()
                .Any(i => domainRepoInterfaces.Contains(i));
            Assert.True(implements,
                $"{repo.FullName} must implement a Domain repository interface.");
        }
    }

    [Fact(DisplayName = "Infrastructure — le DbContext réside dans Infrastructure.Persistence")]
    public void Infrastructure_DbContext_ResideInPersistenceNamespace()
    {
        var result = Types.InAssembly(Assemblies.Infrastructure)
            .That().HaveNameEndingWith("DbContext")
            .Should().ResideInNamespace($"{Ns.Infrastructure}.Persistence")
            .GetResult();
        Assert.True(result.IsSuccessful, Helpers.Format(result));
    }

    [Fact(DisplayName = "Infrastructure — les configurations EF résident dans Infrastructure.Persistence")]
    public void Infrastructure_EfConfigurations_ResideInPersistenceNamespace()
    {
        var result = Types.InAssembly(Assemblies.Infrastructure)
            .That().HaveNameEndingWith("Configuration")
            .And().AreNotInterfaces()
            .Should().ResideInNamespace($"{Ns.Infrastructure}.Persistence")
            .GetResult();
        Assert.True(result.IsSuccessful, Helpers.Format(result));
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. Couche API
// ─────────────────────────────────────────────────────────────────────────────

public sealed class ApiLayerTests
{
    [Fact(DisplayName = "API — les Controllers finissent par Controller")]
    public void Api_Controllers_NamingConvention()
    {
        var result = Types.InAssembly(Assemblies.Api)
            .That().Inherit(typeof(Microsoft.AspNetCore.Mvc.ControllerBase))
            .And().AreNotAbstract()
            .Should().HaveNameEndingWith("Controller")
            .GetResult();
        Assert.True(result.IsSuccessful, Helpers.Format(result));
    }

    [Fact(DisplayName = "API — les Controllers résident dans le namespace Controllers")]
    public void Api_Controllers_ResideInControllersNamespace()
    {
        var result = Types.InAssembly(Assemblies.Api)
            .That().Inherit(typeof(Microsoft.AspNetCore.Mvc.ControllerBase))
            .Should().ResideInNamespace($"{Ns.Api}.Controllers")
            .GetResult();
        Assert.True(result.IsSuccessful, Helpers.Format(result));
    }

    [Fact(DisplayName = "API — les Controllers ne dépendent pas directement des repositories Domain")]
    public void Api_Controllers_DoNotDependDirectlyOnDomainRepositories()
    {
        // Controllers délèguent à MediatR — ils ne doivent pas injecter IXxxRepository.
        var result = Types.InAssembly(Assemblies.Api)
            .That().Inherit(typeof(Microsoft.AspNetCore.Mvc.ControllerBase))
            .ShouldNot().HaveDependencyOn($"{Ns.Domain}.Repositories")
            .GetResult();
        Assert.True(result.IsSuccessful, Helpers.Format(result));
    }

    [Fact(DisplayName = "API — les Controllers ne dépendent pas directement de l'Infrastructure")]
    public void Api_Controllers_DoNotDependOnInfrastructure()
    {
        var result = Types.InAssembly(Assemblies.Api)
            .That().Inherit(typeof(Microsoft.AspNetCore.Mvc.ControllerBase))
            .ShouldNot().HaveDependencyOn(Ns.Infrastructure)
            .GetResult();
        Assert.True(result.IsSuccessful, Helpers.Format(result));
    }

    [Fact(DisplayName = "API — les Hubs ne dépendent pas directement des repositories Domain")]
    public void Api_Hubs_DoNotDependDirectlyOnDomainRepositories()
    {
        // Toute logique métier dans les hubs doit passer par IMediator.
        // Un hub qui injecte IXxxRepository court-circuite la couche Application.
        var result = Types.InAssembly(Assemblies.Api)
            .That().ResideInNamespace($"{Ns.Api}.Hubs")
            .ShouldNot().HaveDependencyOn($"{Ns.Domain}.Repositories")
            .GetResult();
        Assert.True(result.IsSuccessful, Helpers.Format(result));
    }

    [Fact(DisplayName = "API — les Hubs finissent par Hub")]
    public void Api_Hubs_NamingConvention()
    {
        var result = Types.InAssembly(Assemblies.Api)
            .That().Inherit(typeof(Microsoft.AspNetCore.SignalR.Hub))
            .And().AreNotAbstract()
            .Should().HaveNameEndingWith("Hub")
            .GetResult();
        Assert.True(result.IsSuccessful, Helpers.Format(result));
    }

    [Fact(DisplayName = "API — les Hubs résident dans le namespace Hubs")]
    public void Api_Hubs_ResideInHubsNamespace()
    {
        var result = Types.InAssembly(Assemblies.Api)
            .That().Inherit(typeof(Microsoft.AspNetCore.SignalR.Hub))
            .Should().ResideInNamespace($"{Ns.Api}.Hubs")
            .GetResult();
        Assert.True(result.IsSuccessful, Helpers.Format(result));
    }

    [Fact(DisplayName = "API — les Hubs ne dépendent pas directement de l'Infrastructure")]
    public void Api_Hubs_DoNotDependOnInfrastructure()
    {
        var result = Types.InAssembly(Assemblies.Api)
            .That().ResideInNamespace($"{Ns.Api}.Hubs")
            .ShouldNot().HaveDependencyOn(Ns.Infrastructure)
            .GetResult();
        Assert.True(result.IsSuccessful, Helpers.Format(result));
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. Règles transversales
// ─────────────────────────────────────────────────────────────────────────────

public sealed class CrossCuttingTests
{
    [Fact(DisplayName = "Architecture — les Handlers sont des classes scellées")]
    public void Application_Handlers_AreSealed()
    {
        var result = Types.InAssembly(Assemblies.Application)
            .That().HaveNameEndingWith("Handler")
            .Should().BeSealed()
            .GetResult();
        Assert.True(result.IsSuccessful, Helpers.Format(result));
    }

    [Fact(DisplayName = "Architecture — les Controllers dépendent de IMediator")]
    public void Api_Controllers_DependOn_IMediator()
    {
        // AttachmentsController injecte IContentStore directement (uploads/downloads binaires).
        var result = Types.InAssembly(Assemblies.Api)
            .That().Inherit(typeof(Microsoft.AspNetCore.Mvc.ControllerBase))
            .And().AreNotAbstract()
            .And().DoNotHaveNameEndingWith("AttachmentsController")
            .Should().HaveDependencyOn("MediatR")
            .GetResult();
        Assert.True(result.IsSuccessful, Helpers.Format(result));
    }

    [Fact(DisplayName = "Architecture — les Hubs dépendent de IMediator")]
    public void Api_Hubs_DependOn_IMediator()
    {
        // Filtre sur Inherit(Hub) pour exclure les DTOs co-localisés dans le namespace Hubs.
        var result = Types.InAssembly(Assemblies.Api)
            .That().Inherit(typeof(Microsoft.AspNetCore.SignalR.Hub))
            .And().AreNotAbstract()
            .Should().HaveDependencyOn("MediatR")
            .GetResult();
        Assert.True(result.IsSuccessful, Helpers.Format(result));
    }

    [Fact(DisplayName = "Architecture — les assemblies de production ne dépendent pas de xUnit")]
    public void Production_Assemblies_DoNotDependOn_Xunit()
    {
        foreach (var (name, asm) in new[]
        {
            (nameof(Assemblies.Domain), Assemblies.Domain),
            (nameof(Assemblies.Application), Assemblies.Application),
            (nameof(Assemblies.Infrastructure), Assemblies.Infrastructure),
            (nameof(Assemblies.Api), Assemblies.Api),
        })
        {
            var result = Types.InAssembly(asm)
                .ShouldNot().HaveDependencyOn("Xunit")
                .GetResult();
            Assert.True(result.IsSuccessful, $"[{name}] " + Helpers.Format(result));
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

file static class Helpers
{
    internal static string Format(TestResult result)
        => $"Failing types:\n  {string.Join("\n  ", result.FailingTypeNames ?? [])}";
}
