// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
using MediatR;
using Savoire.Application.Common;
using Savoire.Domain.Repositories;

namespace Savoire.Application.Sync.RegisterDocuments;

/// <summary>
/// Inscrit des documents dans un vault (registre « document -> vault »). En
/// mode serveur, creer un document commence par la : sans inscription, le
/// controle d'acces refuse le document. Exige le droit d'ecrire dans le vault.
/// Rend les documents refuses parce qu'inscrits dans un autre vault.
/// </summary>
public sealed record RegisterDocumentsCommand(string CallerId, string VaultId, IReadOnlyCollection<string> DocIds)
    : IRequest<IReadOnlyList<string>>, IRequiresVaultAccess
{
    public VaultAccessLevel RequiredAccess => VaultAccessLevel.Write;
}

public sealed class RegisterDocumentsCommandHandler(IVaultDocumentRepository vaultDocuments)
    : IRequestHandler<RegisterDocumentsCommand, IReadOnlyList<string>>
{
    public Task<IReadOnlyList<string>> Handle(RegisterDocumentsCommand cmd, CancellationToken ct) =>
        vaultDocuments.RegisterAsync(cmd.VaultId, cmd.DocIds, cmd.CallerId, ct);
}
