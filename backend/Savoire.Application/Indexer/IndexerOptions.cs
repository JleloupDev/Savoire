// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// Configuration du pair indexeur (section « Indexer »). Voir ADR-027,
// docs/Architecture/indexer-protocol.md et appsettings.Example.json.

namespace Savoire.Application.Indexer;

public sealed class IndexerOptions
{
    public const string Section = "Indexer";

    /// <summary>
    /// Jeton de service partage avec le pair (SAVOIRE_INDEXER_TOKEN cote pair).
    /// Absent : pas d'API interne (404), routes publiques en 503.
    /// </summary>
    public string? ServiceToken { get; set; }

    /// <summary>Instances du pair : [{ name, url }]. Les vaults sont repartis par hachage de rendez-vous.</summary>
    public List<IndexerInstanceOptions> Instances { get; set; } = [];

    /// <summary>Delai maximal d'un appel relaye au pair ; au-dela, 503.</summary>
    public int TimeoutMs { get; set; } = 5000;

    /// <summary>Taille maximale du corps d'une requete publique (64 Kio).</summary>
    public int MaxBodyBytes { get; set; } = 64 * 1024;

    /// <summary>Taille maximale d'une reponse du pair ; au-dela, 503.</summary>
    public int MaxResponseBytes { get; set; } = 8 * 1024 * 1024;

    /// <summary>Recherche globale : instances interrogees en meme temps, au plus.</summary>
    public int SearchParallelism { get; set; } = 4;

    /// <summary>Valeur de Retry-After (secondes) quand le pair est absent ou indisponible.</summary>
    public int RetryAfterSeconds { get; set; } = 5;

    public IndexerRateLimitOptions RateLimit { get; set; } = new();

    /// <summary>Pair indexeur active : un jeton de service est configure.</summary>
    public bool Enabled => !string.IsNullOrWhiteSpace(ServiceToken);

    /// <summary>L'instance de ce nom, ou null.</summary>
    public IndexerInstanceOptions? FindInstance(string? name) =>
        name is null ? null : Instances.FirstOrDefault(i => string.Equals(i.Name, name, StringComparison.Ordinal));

    /// <summary>Erreurs de configuration (noms uniques, adresses http(s) absolues, bornes positives).</summary>
    public IReadOnlyList<string> Validate()
    {
        var errors = new List<string>();
        var names = new HashSet<string>(StringComparer.Ordinal);
        foreach (IndexerInstanceOptions i in Instances)
        {
            if (string.IsNullOrWhiteSpace(i.Name)) errors.Add("Indexer:Instances : nom vide.");
            else if (!names.Add(i.Name)) errors.Add($"Indexer:Instances : nom en double « {i.Name} ».");
            if (!Uri.TryCreate(i.Url, UriKind.Absolute, out Uri? uri) || (uri.Scheme != Uri.UriSchemeHttp && uri.Scheme != Uri.UriSchemeHttps))
                errors.Add($"Indexer:Instances : adresse invalide pour « {i.Name} » (http(s) absolue attendue).");
        }
        if (TimeoutMs <= 0) errors.Add("Indexer:TimeoutMs doit etre positif.");
        if (MaxBodyBytes <= 0) errors.Add("Indexer:MaxBodyBytes doit etre positif.");
        if (MaxResponseBytes <= 0) errors.Add("Indexer:MaxResponseBytes doit etre positif.");
        if (SearchParallelism <= 0) errors.Add("Indexer:SearchParallelism doit etre positif.");
        if (RetryAfterSeconds <= 0) errors.Add("Indexer:RetryAfterSeconds doit etre positif.");
        if (RateLimit.PerUserPerMinute <= 0 || RateLimit.PerVaultPerMinute <= 0)
            errors.Add("Indexer:RateLimit : les limites doivent etre positives.");
        return errors;
    }
}

public sealed class IndexerInstanceOptions
{
    public string Name { get; set; } = "";
    public string Url  { get; set; } = "";
}

/// <summary>Limites de debit des routes publiques du pair (seau de jetons, par minute).</summary>
public sealed class IndexerRateLimitOptions
{
    public int PerUserPerMinute  { get; set; } = 300;
    public int PerVaultPerMinute { get; set; } = 1200;
}
