// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// PUT /api/v1/vaults/{vaultId}/indexer : choisir le pair qui sert le vault.
// Reserve au proprietaire du vault.
//
// En mode « organization », le serveur ne relaie pas : il rend l'adresse au
// client (503 + { mode, url } sur les routes du pair). Le circuit complet du
// pair d'organisation (requetes chiffrees, demandeurs authentifies par leur
// identite de membre) viendra avec la reprise du profil chiffre (ADR-027).

using FluentValidation;
using MediatR;
using Savoire.Application.Common;
using Savoire.Domain.Aggregates;
using Savoire.Domain.Enums;
using Savoire.Domain.Exceptions;
using Savoire.Domain.ReadModels;
using Savoire.Domain.Repositories;

namespace Savoire.Application.Indexer.VaultIndexer;

/// <summary>Le controle d'acces exige d'etre membre ; le handler exige d'etre proprietaire.</summary>
public sealed record SetVaultIndexerCommand(string CallerId, string VaultId, string Mode, string? Url)
    : IRequest<VaultIndexerDto>, IRequiresVaultAccess
{
    public VaultAccessLevel RequiredAccess => VaultAccessLevel.Read;
}

public sealed class SetVaultIndexerCommandValidator : AbstractValidator<SetVaultIndexerCommand>
{
    public SetVaultIndexerCommandValidator()
    {
        RuleFor(c => c.Mode)
            .Must(m => m.TryParseIndexerMode(out _))
            .WithMessage("mode : managed, organization ou none.");
        RuleFor(c => c.Url)
            .NotEmpty()
            .MaximumLength(2048)
            .Must(BeHttpUrl).WithMessage("url : adresse http(s) absolue.")
            .When(c => c.Mode == "organization");
        RuleFor(c => c.Url)
            .Empty().WithMessage("url : seulement pour le mode organization.")
            .When(c => c.Mode != "organization");
    }

    private static bool BeHttpUrl(string? url) =>
        Uri.TryCreate(url, UriKind.Absolute, out Uri? uri) && (uri.Scheme == Uri.UriSchemeHttps || uri.Scheme == Uri.UriSchemeHttp);
}

public sealed class SetVaultIndexerCommandHandler(
    IVaultRepository               vaults,
    IVaultIndexerSettingRepository settings) : IRequestHandler<SetVaultIndexerCommand, VaultIndexerDto>
{
    public async Task<VaultIndexerDto> Handle(SetVaultIndexerCommand cmd, CancellationToken ct)
    {
        IndexerCallers.RequireAccount(cmd.CallerId);
        Vault vault = await vaults.GetByIdAsync(cmd.VaultId, ct) ?? throw new VaultNotFoundException(cmd.VaultId);
        vault.RequireOwner(cmd.CallerId);

        IndexerMode mode = cmd.Mode.ParseIndexerMode();
        var setting = new VaultIndexerSetting(cmd.VaultId, mode, mode == IndexerMode.Organization ? cmd.Url : null);
        await settings.SetAsync(setting, cmd.CallerId, ct);
        return VaultIndexerDto.From(setting, null);
    }
}
