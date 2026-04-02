// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// Hosted service that initializes the Blob container at application startup.

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
