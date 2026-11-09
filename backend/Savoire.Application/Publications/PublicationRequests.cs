// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Publier une note sur le web, comme Notion : une adresse publique en lecture
// seule, /p/{slug}, mise a jour a chaque modification de la note.
//
// Le serveur ne lit pas les notes (elles sont des CRDT) : c'est l'application
// d'un editeur qui rend la page en HTML et l'envoie. La page publique est
// servie telle quelle, sous une politique qui interdit tout script.
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using FluentValidation;
using FluentValidation.Results;
using MediatR;
using Savoire.Application.Common;
using Savoire.Domain.Exceptions;
using Savoire.Domain.ReadModels;
using Savoire.Domain.Repositories;

namespace Savoire.Application.Publications;

public sealed record PublicationDto(string Slug, string Path, bool Indexable, DateTime CreatedAt, DateTime UpdatedAt);

/// <summary>Taille maximale du HTML d'une page (images comprises).</summary>
public static class PublicationLimits
{
    public const int MaxHtmlChars = 15 * 1024 * 1024;
    public const int MaxTitleChars = 300;
    public const int MaxDescriptionChars = 500;
}

/// <summary>La publication d'une note, ou null.</summary>
public sealed record GetPublicationQuery(string VaultId, string DocumentId, string CallerId)
    : IRequest<PublicationDto?>, IRequiresVaultAccess
{
    public VaultAccessLevel RequiredAccess => VaultAccessLevel.Read;
}

/// <summary>
/// Publie la note, ou met a jour sa page. La premiere fois, une adresse est
/// choisie d'apres le titre. Exige le droit d'ecrire dans le vault.
/// </summary>
public sealed record PublishDocumentCommand(
    string VaultId, string DocumentId, string CallerId,
    string Title, string Description, string Html, bool Indexable)
    : IRequest<PublicationDto>, IRequiresVaultAccess
{
    public VaultAccessLevel RequiredAccess => VaultAccessLevel.Write;
}

/// <summary>Retire la page : l'adresse ne repond plus.</summary>
public sealed record UnpublishDocumentCommand(string VaultId, string DocumentId, string CallerId)
    : IRequest, IRequiresVaultAccess
{
    public VaultAccessLevel RequiredAccess => VaultAccessLevel.Write;
}

/// <summary>Page publique, sans compte. Null : rien a cette adresse.</summary>
public sealed record GetPublicPageQuery(string Slug) : IRequest<Publication?>;

/// <summary>Adresse d'une page : tiree du titre, plus 6 caracteres au hasard.</summary>
public static class PublicationSlug
{
    public static string For(string title) => Publications.Slugify(title);
}

internal static class Publications
{
    public static PublicationDto ToDto(Publication p) => new(p.Slug, $"/p/{p.Slug}", p.Indexable, p.CreatedAt, p.UpdatedAt);

    public static async Task EnsureInVault(IVaultDocumentRepository docs, string vaultId, string documentId, CancellationToken ct)
    {
        string? owner = await docs.GetVaultIdAsync(documentId, ct);
        if (owner != vaultId) throw new DocumentNotFoundException(documentId);
    }

    /// <summary>« Mon rapport 2026 » -> « mon-rapport-2026-k3x9p2 ».</summary>
    public static string Slugify(string title)
    {
        string normalized = title.Normalize(NormalizationForm.FormD);
        StringBuilder sb = new();
        foreach (char c in normalized)
        {
            if (System.Globalization.CharUnicodeInfo.GetUnicodeCategory(c) == System.Globalization.UnicodeCategory.NonSpacingMark) continue;
            sb.Append(char.IsLetterOrDigit(c) && c < 128 ? char.ToLowerInvariant(c) : '-');
        }
        string slug = Regex.Replace(sb.ToString(), "-+", "-").Trim('-');
        if (slug.Length > 60) slug = slug[..60].TrimEnd('-');
        const string alphabet = "abcdefghijkmnpqrstuvwxyz23456789";
        string suffix = new(Enumerable.Range(0, 6).Select(_ => alphabet[RandomNumberGenerator.GetInt32(alphabet.Length)]).ToArray());
        return string.IsNullOrEmpty(slug) ? suffix : $"{slug}-{suffix}";
    }

    public static string Clip(string? s, int max) => (s ?? string.Empty).Length > max ? s![..max] : s ?? string.Empty;
}

public sealed class GetPublicationQueryHandler(IPublicationRepository publications, IVaultDocumentRepository docs)
    : IRequestHandler<GetPublicationQuery, PublicationDto?>
{
    public async Task<PublicationDto?> Handle(GetPublicationQuery q, CancellationToken ct)
    {
        await Publications.EnsureInVault(docs, q.VaultId, q.DocumentId, ct);
        Publication? p = await publications.GetByDocumentAsync(q.DocumentId, ct);
        return p is null ? null : Publications.ToDto(p);
    }
}

public sealed class PublishDocumentCommandHandler(IPublicationRepository publications, IVaultDocumentRepository docs)
    : IRequestHandler<PublishDocumentCommand, PublicationDto>
{
    public async Task<PublicationDto> Handle(PublishDocumentCommand cmd, CancellationToken ct)
    {
        if (cmd.Html.Length > PublicationLimits.MaxHtmlChars)
            throw new ValidationException([new ValidationFailure("html", "Page trop lourde pour être publiée.")]);
        await Publications.EnsureInVault(docs, cmd.VaultId, cmd.DocumentId, ct);
        string title = Publications.Clip(cmd.Title.Trim(), PublicationLimits.MaxTitleChars);
        string description = Publications.Clip(cmd.Description.Trim(), PublicationLimits.MaxDescriptionChars);
        DateTime now = DateTime.UtcNow;
        Publication? existing = await publications.GetByDocumentAsync(cmd.DocumentId, ct);
        if (existing is not null)
        {
            await publications.UpdateAsync(cmd.DocumentId, title, description, cmd.Html, cmd.Indexable, now, ct);
            return Publications.ToDto(existing with { Title = title, Description = description, Html = cmd.Html, Indexable = cmd.Indexable, UpdatedAt = now });
        }
        string slug;
        do slug = Publications.Slugify(title);
        while (await publications.SlugExistsAsync(slug, ct));
        Publication created = new(slug, cmd.VaultId, cmd.DocumentId, title, description, cmd.Html, cmd.Indexable, cmd.CallerId, now, now);
        await publications.AddAsync(created, ct);
        return Publications.ToDto(created);
    }
}

public sealed class UnpublishDocumentCommandHandler(IPublicationRepository publications, IVaultDocumentRepository docs)
    : IRequestHandler<UnpublishDocumentCommand>
{
    public async Task Handle(UnpublishDocumentCommand cmd, CancellationToken ct)
    {
        await Publications.EnsureInVault(docs, cmd.VaultId, cmd.DocumentId, ct);
        await publications.DeleteAsync(cmd.DocumentId, ct);
    }
}

public sealed class GetPublicPageQueryHandler(IPublicationRepository publications, IVaultDocumentRepository docs)
    : IRequestHandler<GetPublicPageQuery, Publication?>
{
    public async Task<Publication?> Handle(GetPublicPageQuery q, CancellationToken ct)
    {
        if (!Regex.IsMatch(q.Slug, "^[a-z0-9-]{1,120}$")) return null;
        Publication? p = await publications.GetBySlugAsync(q.Slug, ct);
        // Note ou vault supprime : la page ne repond plus.
        if (p is null || await docs.GetVaultIdAsync(p.DocumentId, ct) != p.VaultId) return null;
        return p;
    }
}
