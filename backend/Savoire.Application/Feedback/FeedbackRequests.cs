// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Retours des testeurs : la bulle de l'application envoie un message, une
// capture de l'ecran (si la personne la garde) et le contexte technique.
// L'administrateur les lit, les range, et les fait analyser par l'IA depuis
// la page Admin (l'analyse se fait chez lui, pas sur le serveur).
using FluentValidation;
using FluentValidation.Results;
using MediatR;
using Microsoft.AspNetCore.Identity;
using Savoire.Application.Sharing;
using Savoire.Domain.Entities;
using Savoire.Domain.Exceptions;
using Savoire.Domain.ReadModels;
using Savoire.Domain.Repositories;

namespace Savoire.Application.Feedback;

public static class FeedbackLimits
{
    public const int MaxMessageChars = 5000;
    public const int MaxContextChars = 8 * 1024;
    public const int MaxScreenshotBytes = 4 * 1024 * 1024;
    /// <summary>Retours non ranges au plus par compte : la base ne se remplit pas sans fin.</summary>
    public const int MaxOpenPerUser = 200;

    /// <summary>Type d'une capture d'apres ses premiers octets ; null : ni PNG ni JPEG.</summary>
    public static string? ImageType(byte[] bytes)
    {
        if (bytes.Length > 8 && bytes[0] == 0x89 && bytes[1] == 0x50 && bytes[2] == 0x4E && bytes[3] == 0x47) return "image/png";
        if (bytes.Length > 3 && bytes[0] == 0xFF && bytes[1] == 0xD8 && bytes[2] == 0xFF) return "image/jpeg";
        return null;
    }
}

// ── Envoi (tout compte connecte) ─────────────────────────────────────────────

public sealed record SubmitFeedbackCommand(
    string CallerId, string Message, string? ContextJson, byte[]? Screenshot, string? UserAgent)
    : IRequest<string>;

public sealed class SubmitFeedbackCommandValidator : AbstractValidator<SubmitFeedbackCommand>
{
    public SubmitFeedbackCommandValidator()
    {
        RuleFor(c => c.Message).NotEmpty().WithMessage("Écrivez quelques mots.")
            .MaximumLength(FeedbackLimits.MaxMessageChars);
        RuleFor(c => c.ContextJson).MaximumLength(FeedbackLimits.MaxContextChars);
        RuleFor(c => c.Screenshot)
            .Must(s => s is null || s.Length <= FeedbackLimits.MaxScreenshotBytes).WithMessage("Capture trop lourde.")
            .Must(s => s is null || FeedbackLimits.ImageType(s) is not null).WithMessage("La capture doit être une image PNG ou JPEG.");
    }
}

public sealed class SubmitFeedbackCommandHandler(IFeedbackRepository feedback) : IRequestHandler<SubmitFeedbackCommand, string>
{
    public async Task<string> Handle(SubmitFeedbackCommand c, CancellationToken ct)
    {
        if (ShareLinkGuard.IsShareLinkCaller(c.CallerId) || ShareLinkGuard.IsViewCaller(c.CallerId))
            throw new AccessDeniedException("Un lien de partage ne peut pas envoyer de retour.");
        if (await feedback.CountOpenForUserAsync(c.CallerId, ct) >= FeedbackLimits.MaxOpenPerUser)
            throw new ValidationException([new ValidationFailure("message", "Trop de retours en attente : réessayez plus tard.")]);

        string? userAgent = c.UserAgent is { Length: > 512 } ua ? ua[..512] : c.UserAgent;
        var report = new FeedbackReport(
            Guid.NewGuid().ToString("N"), c.CallerId, c.Message.Trim(),
            string.IsNullOrWhiteSpace(c.ContextJson) ? "{}" : c.ContextJson,
            userAgent, c.Screenshot, c.Screenshot is null ? null : FeedbackLimits.ImageType(c.Screenshot),
            DateTime.UtcNow, null);
        await feedback.AddAsync(report, ct);
        return report.Id;
    }
}

// ── Administration ───────────────────────────────────────────────────────────

public sealed record FeedbackReportDto(
    string Id, string UserId, string? UserName, string? UserEmail, string Message,
    string Context, string? UserAgent, bool HasScreenshot, DateTime CreatedAt, DateTime? ArchivedAt);

public sealed record ListFeedbackQuery(bool IncludeArchived) : IRequest<IReadOnlyList<FeedbackReportDto>>;

public sealed class ListFeedbackQueryHandler(IFeedbackRepository feedback, UserManager<AppUser> users)
    : IRequestHandler<ListFeedbackQuery, IReadOnlyList<FeedbackReportDto>>
{
    public async Task<IReadOnlyList<FeedbackReportDto>> Handle(ListFeedbackQuery q, CancellationToken ct)
    {
        IReadOnlyList<FeedbackReportSummary> rows = await feedback.ListAsync(q.IncludeArchived, ct);
        List<string> ids = rows.Select(r => r.UserId).Distinct().ToList();
        Dictionary<string, AppUser> byId = users.Users.Where(u => ids.Contains(u.Id)).ToDictionary(u => u.Id);
        return rows.Select(r =>
        {
            AppUser? u = byId.GetValueOrDefault(r.UserId);
            return new FeedbackReportDto(r.Id, r.UserId, u?.DisplayName, u?.Email, r.Message, r.ContextJson,
                r.UserAgent, r.HasScreenshot, r.CreatedAt, r.ArchivedAt);
        }).ToList();
    }
}

public sealed record GetFeedbackScreenshotQuery(string Id) : IRequest<(byte[] Bytes, string Type)?>;

public sealed class GetFeedbackScreenshotQueryHandler(IFeedbackRepository feedback)
    : IRequestHandler<GetFeedbackScreenshotQuery, (byte[] Bytes, string Type)?>
{
    public Task<(byte[] Bytes, string Type)?> Handle(GetFeedbackScreenshotQuery q, CancellationToken ct) =>
        feedback.GetScreenshotAsync(q.Id, ct);
}

/// <summary>Range un retour (Archived) ou le remet dans la liste. False : inconnu.</summary>
public sealed record ArchiveFeedbackCommand(string Id, bool Archived) : IRequest<bool>;

public sealed class ArchiveFeedbackCommandHandler(IFeedbackRepository feedback) : IRequestHandler<ArchiveFeedbackCommand, bool>
{
    public Task<bool> Handle(ArchiveFeedbackCommand c, CancellationToken ct) =>
        feedback.SetArchivedAsync(c.Id, c.Archived ? DateTime.UtcNow : null, ct);
}

public sealed record DeleteFeedbackCommand(string Id) : IRequest<bool>;

public sealed class DeleteFeedbackCommandHandler(IFeedbackRepository feedback) : IRequestHandler<DeleteFeedbackCommand, bool>
{
    public Task<bool> Handle(DeleteFeedbackCommand c, CancellationToken ct) => feedback.DeleteAsync(c.Id, ct);
}
