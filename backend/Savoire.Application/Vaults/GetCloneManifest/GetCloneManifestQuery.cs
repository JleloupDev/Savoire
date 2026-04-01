// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
using MediatR;
using Savoire.Application.Common;

namespace Savoire.Application.Vaults.GetCloneManifest;

public record GetCloneManifestQuery(string CallerId, string VaultId, string? LocalPath)
    : IRequest<CloneManifestDto>, IRequiresVaultAccess
{
    public VaultAccessLevel RequiredAccess => VaultAccessLevel.Read;
}
