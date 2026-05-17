// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
using MediatR;

namespace Savoire.Application.Vaults.AddVaultMember;

public sealed record AddVaultMemberCommand(string CallerId, string VaultId, string MemberId, string Role) : IRequest;
