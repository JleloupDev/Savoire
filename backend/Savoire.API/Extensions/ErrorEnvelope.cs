// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Rapports d'erreur de l'appli (web, bureau) : le navigateur les envoie a
// l'API (« tunnel » de Sentry), qui les relaie a GlitchTip sur le reseau
// interne. GlitchTip n'est donc jamais expose sur Internet.
//
// Un rapport (enveloppe Sentry) commence par une ligne JSON qui porte le DSN
// de l'expediteur. On ne relaie que le DSN attendu (ErrorReporting:ClientDsn).
using System.Text;
using System.Text.Json;

namespace Savoire.Server.Extensions;

public static class ErrorEnvelope
{
    /// <summary>Le projet et la cle du DSN d'un DSN Sentry (https://cle@hote/projet).</summary>
    public static (string Key, string ProjectId)? ParseDsn(string? dsn)
    {
        if (string.IsNullOrWhiteSpace(dsn) || !Uri.TryCreate(dsn, UriKind.Absolute, out Uri? uri)) return null;
        string key = uri.UserInfo.Split(':')[0];
        string project = uri.AbsolutePath.TrimEnd('/').Split('/').LastOrDefault() ?? "";
        if (key.Length == 0 || project.Length == 0 || !project.All(char.IsAsciiDigit)) return null;
        return (key, project);
    }

    /// <summary>
    /// Le DSN annonce en tete de l'enveloppe, s'il est celui attendu ; sinon null
    /// (rapport refuse).
    /// </summary>
    public static (string Key, string ProjectId)? Route(ReadOnlySpan<byte> body, string? allowedDsn)
    {
        (string Key, string ProjectId)? allowed = ParseDsn(allowedDsn);
        if (allowed is null) return null;
        int newline = body.IndexOf((byte)'\n');
        ReadOnlySpan<byte> header = newline < 0 ? body : body[..newline];
        try
        {
            using JsonDocument doc = JsonDocument.Parse(Encoding.UTF8.GetString(header));
            if (!doc.RootElement.TryGetProperty("dsn", out JsonElement dsnEl) || dsnEl.ValueKind != JsonValueKind.String) return null;
            return ParseDsn(dsnEl.GetString()) == allowed ? allowed : null;
        }
        catch (JsonException)
        {
            return null;
        }
    }
}
