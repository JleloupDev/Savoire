// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// Content storage interface — moved into Application (application concern).
// Implemented by LocalFileContentStore in Infrastructure.

namespace Savoire.Application.Abstractions;

public interface IContentStore
{
    Task<Stream?> ReadAttachmentAsync(string vaultId, string storagePath, CancellationToken ct = default);
    Task<string> WriteAttachmentAsync(string vaultId, string filename, Stream content, CancellationToken ct = default);
    Task DeleteAttachmentAsync(string vaultId, string storagePath, CancellationToken ct = default);
}
