// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// Hosted service qui initialise le container Blob au démarrage de l'application.

using Microsoft.Extensions.Hosting;

namespace Savoire.Infrastructure.Storage;

internal class BlobContainerInitializer(AzureBlobContentStore store)
    : IHostedService
{
    public Task StartAsync(CancellationToken ct)
        => store.InitializeAsync();

    public Task StopAsync(CancellationToken ct)
        => Task.CompletedTask;
}
