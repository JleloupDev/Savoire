// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
using MediatR;

namespace Savoire.Application.Sync.SnapshotVault;

public sealed record SnapshotVaultCommand(string VaultId, byte[] SnapshotBytes)
    : IRequest;
