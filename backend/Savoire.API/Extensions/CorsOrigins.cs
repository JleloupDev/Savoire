// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// Origines acceptees par CORS (REST et SignalR).
//
// - AllowedOrigins : les origines web, une liste explicite (comme avant).
// - DesktopAppOrigins : l'application de bureau (Tauri). Par defaut ses
//   origines connues : tauri://localhost (macOS, Linux), http(s)://tauri.localhost
//   (Windows). Une liste vide [] la refuse.
// - Rien de configure, en Development seulement : les adresses locales
//   (localhost, 127.0.0.1, ::1, tout port), pour le Vite de dev. Plus de
//   « toutes les origines » : une origine inconnue est refusee.
//
// Le jeton passe en en-tete Authorization (et en access_token pour les
// WebSockets de SignalR) : aucune authentification par cookie. AllowCredentials
// reste pour le client SignalR, qui envoie ses requetes « avec identifiants »
// par defaut ; il est sans risque avec une liste d'origines explicite.

using Microsoft.AspNetCore.Cors.Infrastructure;

namespace Savoire.Server.Extensions;

public static class CorsOrigins
{
    /// <summary>Origines de l'application Tauri, quand DesktopAppOrigins n'est pas configure.</summary>
    public static readonly string[] DefaultDesktopOrigins =
    [
        "tauri://localhost",
        "http://tauri.localhost",
        "https://tauri.localhost",
    ];

    /// <summary>Liste explicite des origines acceptees (web + bureau).</summary>
    public static string[] Explicit(IConfiguration config)
    {
        string[] web = config.GetSection("AllowedOrigins").Get<string[]>() ?? [];
        IConfigurationSection desktopSection = config.GetSection("DesktopAppOrigins");
        // Section absente : origines Tauri par defaut. Presente mais vide : aucune.
        string[] desktop = desktopSection.Exists()
            ? desktopSection.Get<string[]>() ?? []
            : DefaultDesktopOrigins;
        return web.Concat(desktop)
            .Select(o => o.Trim().TrimEnd('/'))
            .Where(o => o.Length > 0)
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToArray();
    }

    /// <summary>Origine d'une page servie en local (dev) : localhost, 127.0.0.1 ou ::1, http ou https.</summary>
    public static bool IsLoopback(string origin) =>
        Uri.TryCreate(origin, UriKind.Absolute, out Uri? uri)
        && (uri.Scheme == Uri.UriSchemeHttp || uri.Scheme == Uri.UriSchemeHttps)
        && uri.IsLoopback;

    /// <summary>
    /// Regle d'acceptation d'une origine. `isDevelopment` : sans AllowedOrigins,
    /// les origines locales sont acceptees en plus.
    /// </summary>
    public static Func<string, bool> Rule(IConfiguration config, bool isDevelopment)
    {
        var allowed = new HashSet<string>(Explicit(config), StringComparer.OrdinalIgnoreCase);
        bool hasWeb = (config.GetSection("AllowedOrigins").Get<string[]>() ?? []).Length > 0;
        bool loopback = isDevelopment && !hasWeb;
        return origin => allowed.Contains(origin.TrimEnd('/')) || (loopback && IsLoopback(origin));
    }

    /// <summary>La politique par defaut de l'API.</summary>
    public static void Configure(CorsPolicyBuilder policy, IConfiguration config, bool isDevelopment)
    {
        Func<string, bool> rule = Rule(config, isDevelopment);
        policy.SetIsOriginAllowed(rule)
              .AllowAnyMethod()
              .AllowAnyHeader()
              .AllowCredentials();
    }
}
