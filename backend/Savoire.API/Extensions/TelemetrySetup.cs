// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Exploitation en production (deploy/compose/docker-compose.observability.yml) :
//
//  - Erreurs : envoyees a GlitchTip (compatible Sentry) si ErrorReporting:ApiDsn
//    est renseigne. Exceptions non gerees et journaux de niveau Error.
//  - Metriques : envoyees en OTLP au collecteur (Alloy, puis Prometheus) si
//    OTEL_EXPORTER_OTLP_ENDPOINT est renseigne. Requetes HTTP, connexions
//    temps reel, base, memoire et ramasse-miettes.
//
// Sans ces reglages (dev, tests), rien n'est active ni envoye.
using OpenTelemetry.Metrics;
using OpenTelemetry.Resources;

namespace Savoire.Server.Extensions;

public static class TelemetrySetup
{
    /// <summary>Compteurs integres a ASP.NET Core et a Npgsql, lus sans code de notre part.</summary>
    private static readonly string[] Meters =
    [
        "Microsoft.AspNetCore.Hosting",
        "Microsoft.AspNetCore.Server.Kestrel",
        "Microsoft.AspNetCore.Http.Connections",
        "Microsoft.AspNetCore.Diagnostics",
        "Microsoft.AspNetCore.RateLimiting",
        "Microsoft.AspNetCore.Authentication",
        "Npgsql",
    ];

    public static WebApplicationBuilder AddTelemetry(this WebApplicationBuilder builder)
    {
        IConfiguration cfg = builder.Configuration;

        if (cfg["ErrorReporting:ApiDsn"] is { Length: > 0 } dsn)
        {
            builder.WebHost.UseSentry(o =>
            {
                o.Dsn = dsn;
                o.Environment = cfg["ErrorReporting:Environment"] ?? builder.Environment.EnvironmentName;
                o.Release = cfg["ErrorReporting:Release"];
                // Ni adresse IP, ni cookies, ni corps de requete : le contenu
                // des notes ne doit jamais partir dans un rapport d'erreur.
                o.SendDefaultPii = false;
                o.MaxRequestBodySize = Sentry.Extensibility.RequestSize.None;
                o.TracesSampleRate = 0;
            });
        }

        if (cfg["OTEL_EXPORTER_OTLP_ENDPOINT"] is { Length: > 0 })
        {
            builder.Services.AddOpenTelemetry()
                .ConfigureResource(r => r.AddService(cfg["OTEL_SERVICE_NAME"] ?? "savoire-api"))
                .WithMetrics(m => m
                    .AddAspNetCoreInstrumentation()
                    .AddHttpClientInstrumentation()
                    .AddRuntimeInstrumentation()
                    .AddMeter(Meters)
                    .AddOtlpExporter());
        }

        return builder;
    }
}
