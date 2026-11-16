// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
using Savoire.Domain.ReadModels;

namespace Savoire.Domain.Repositories;

public interface IFeedbackRepository
{
    Task AddAsync(FeedbackReport report, CancellationToken ct = default);
    /// <summary>Retours du plus recent au plus ancien, sans les captures (voir HasScreenshot).</summary>
    Task<IReadOnlyList<FeedbackReportSummary>> ListAsync(bool includeArchived, CancellationToken ct = default);
    Task<(byte[] Bytes, string Type)?> GetScreenshotAsync(string id, CancellationToken ct = default);
    Task<int> CountOpenForUserAsync(string userId, CancellationToken ct = default);
    /// <summary>Range (ou sort des archives) un retour. False : inconnu.</summary>
    Task<bool> SetArchivedAsync(string id, DateTime? at, CancellationToken ct = default);
    Task<bool> DeleteAsync(string id, CancellationToken ct = default);
}
