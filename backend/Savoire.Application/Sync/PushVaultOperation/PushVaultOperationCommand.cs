// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
using MediatR;

namespace Savoire.Application.Sync.PushVaultOperation;

public sealed record PushVaultOperationCommand(string VaultId, byte[] OpBytes)
    : IRequest;
