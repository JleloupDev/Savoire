// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Controles automatiques d'une version, avant toute relecture humaine.
//  - erreur : la version est refusee tout de suite ;
//  - avertissement : la version attend la relecture de Jean.
// Les listes (droits, bibliotheques communes) suivent Savoire :
// packages/plugin-api/src/manifest.ts et libraries.ts.
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using SavoireStore.Data;

namespace SavoireStore.Publishing;

public sealed record Check(string Level, string Message)
{
    public const string Error = "error";
    public const string Warning = "warning";
}

public static partial class PackageChecks
{
    public static readonly string[] Permissions = ["vault:read", "vault:write", "network:*", "ui:editor", "ui:settings", "agents", "ai"];

    // Bibliotheques fournies par Savoire aux plugins du store qui tournent dans
    // la page (« runtime » : « page », le defaut) : meme liste que
    // SHARED_LIBRARIES (plugin-api, libraries.ts). Un plugin « frame » (iframe
    // isolee) n'y a pas acces : tout s'embarque dans main.js.
    public static readonly string[] SharedLibraries =
    [
        "@savoire/plugin-api", "react", "react/jsx-runtime", "react-dom", "react-dom/client",
        "@codemirror/state", "@codemirror/view", "@codemirror/language", "@codemirror/commands",
    ];

    /// <summary>Ou tourne un plugin : dans la page (toute l'API) ou dans une iframe isolee.</summary>
    public static readonly string[] Runtimes = ["page", "frame"];

    /// <summary>
    /// Systemes de Savoire qu'un plugin peut annoncer (« capabilities »), avec
    /// leur nom affiche : meme liste que SAVOIRE_CAPABILITIES (plugin-api,
    /// capabilities.ts). Savoire verifie au chargement ce que le plugin
    /// implemente vraiment.
    /// </summary>
    public static readonly IReadOnlyDictionary<string, string> Capabilities = new Dictionary<string, string>
    {
        ["search"] = "Recherche globale",
        ["links"] = "Liens et backlinks",
        ["index"] = "Index et requêtes",
        ["realtime"] = "Collaboration temps réel",
        ["versions"] = "Versions",
        ["revision"] = "Révision",
        ["compare"] = "Comparaison",
        ["ai-local"] = "IA locale",
        ["ai-mcp"] = "IA par MCP",
        ["modules"] = "Modules intégrables",
    };

    /// <summary>Fichiers du paquet, par sorte : obligatoires puis facultatifs.</summary>
    public static (string[] Required, string[] Optional) FilesOf(string kind) => kind switch
    {
        ItemKinds.Template => (["template.md"], []),
        ItemKinds.Module => (["module.md"], ["styles.css"]),
        // Les notes viennent de notes.zip (voir NotesArchive), rangees sous « notes/ ».
        ItemKinds.Notes => ([], []),
        // Un modele d'agent : consignes, droits par action, budget (aucun code).
        ItemKinds.Agent => (["agent.json"], []),
        _ => (["main.js"], ["styles.css"]),
    };

    public const long MaxPackageBytes = 10 * 1024 * 1024;

    /// <summary>Taille maximale d'un paquet : plus grande pour un paquet de notes (une Bible entiere).</summary>
    public static long MaxPackageBytesOf(string kind) => kind == ItemKinds.Notes ? NotesArchive.MaxContentBytes : MaxPackageBytes;

    [GeneratedRegex(@"^[a-z0-9][a-z0-9-]{2,63}$")]
    public static partial Regex IdRegex();

    [GeneratedRegex(@"^\d{1,6}\.\d{1,6}\.\d{1,6}(?:-[0-9A-Za-z.-]{1,32})?$")]
    public static partial Regex VersionRegex();

    [GeneratedRegex(@"^network:[a-z0-9*.-]{1,253}$")]
    private static partial Regex NetworkPermission();

    [GeneratedRegex(@"\brequire\(\s*['""]([^'""]+)['""]\s*\)")]
    private static partial Regex RequireCall();

    [GeneratedRegex(@"\bimport\s*(?:[\w*{}\s,]+from\s*)?['""]([^'""]+)['""]|\bimport\(\s*['""]([^'""]+)['""]\s*\)")]
    private static partial Regex ImportStatement();

    [GeneratedRegex(@"\beval\s*\(|\bnew\s+Function\s*\(")]
    private static partial Regex DynamicCode();

    public static List<Check> Run(JsonObject manifest, string kind, string tag, IReadOnlyDictionary<string, string> files, bool hasLicenseFile)
    {
        var checks = new List<Check>();
        void Err(string m) => checks.Add(new Check(Check.Error, m));
        void Warn(string m) => checks.Add(new Check(Check.Warning, m));

        string? id = Str(manifest, "id");
        if (id is null || !IdRegex().IsMatch(id)) Err("manifest.json : « id » en minuscules, chiffres et tirets (3 a 64 caracteres).");
        string? name = Str(manifest, "name");
        if (string.IsNullOrWhiteSpace(name) || name.Length > 100) Err("manifest.json : « name » obligatoire (100 caracteres au plus).");
        string? version = Str(manifest, "version");
        if (version is null || !VersionRegex().IsMatch(version)) Err("manifest.json : « version » au format 1.2.3.");
        else if (version != tag.TrimStart('v')) Err($"La release s'appelle « {tag} » mais le manifeste annonce la version {version}.");
        string? description = Str(manifest, "description");
        if (string.IsNullOrWhiteSpace(description)) Err("manifest.json : « description » obligatoire.");
        else if (description.Length > 300) Err("manifest.json : « description » de 300 caracteres au plus.");
        if (manifest["official"] is JsonValue o && o.TryGetValue(out bool official) && official)
            Err("manifest.json : « official » est reserve aux plugins de Savoire.");

        foreach (string p in StrList(manifest, "permissions"))
        {
            if (!Permissions.Contains(p) && !NetworkPermission().IsMatch(p)) Err($"Droit inconnu : « {p} ».");
            if (p.StartsWith("network:", StringComparison.Ordinal)) Warn($"Acces au reseau demande ({p}) : a relire.");
        }
        string runtime = Str(manifest, "runtime") ?? "page";
        if (!Runtimes.Contains(runtime)) Err($"manifest.json : « runtime » vaut « page » ou « frame » (pas « {runtime} »).");
        foreach (string l in StrList(manifest, "libraries"))
        {
            if (!SharedLibraries.Contains(l)) Err($"Bibliotheque « {l} » non fournie aux plugins du store : embarquez-la dans main.js.");
            else if (runtime == "frame") Err($"Bibliotheque « {l} » : un plugin « frame » n'a pas acces aux bibliotheques de Savoire.");
        }
        foreach (string c in StrList(manifest, "capabilities"))
            if (!Capabilities.ContainsKey(c)) Err($"Capacité inconnue : « {c} » (voir la liste dans docs/publier.md).");

        (string[] required, _) = FilesOf(kind);
        foreach (string f in required) if (!files.ContainsKey(f)) Err($"Piece jointe manquante dans la release : {f}.");

        if (kind == ItemKinds.Notes && !files.Keys.Any(k => k.StartsWith(NotesArchive.Prefix, StringComparison.Ordinal)))
            Err($"Piece jointe manquante dans la release : {NotesArchive.AssetName}.");
        if (kind == ItemKinds.Notes && StrList(manifest, "permissions").Count > 0)
            Err("Un paquet de notes ne demande aucun droit (« permissions » vide).");

        if (kind == ItemKinds.Agent)
        {
            if (StrList(manifest, "permissions").Count > 0)
                Err("Un modele d'agent ne demande aucun droit de plugin (« permissions » vide) : ses droits sont dans agent.json.");
            if (files.TryGetValue("agent.json", out string? agentJson)) checks.AddRange(AgentPreset.Check(agentJson));
        }

        long total = files.Values.Sum(v => (long)System.Text.Encoding.UTF8.GetByteCount(v));
        long max = MaxPackageBytesOf(kind);
        if (total > max) Err($"Paquet de plus de {max / (1024 * 1024)} Mio.");

        if (files.TryGetValue("main.js", out string? code))
        {
            var imported = new HashSet<string>();
            foreach (Match m in RequireCall().Matches(code)) imported.Add(m.Groups[1].Value);
            foreach (Match m in ImportStatement().Matches(code)) imported.Add(m.Groups[1].Success ? m.Groups[1].Value : m.Groups[2].Value);
            foreach (string lib in imported.Where(i => runtime == "frame" || !SharedLibraries.Contains(i)))
                Err($"main.js demande « {lib} » : un plugin du store est un seul fichier, embarquez-la dans main.js.");
            if (DynamicCode().IsMatch(code)) Warn("main.js execute du code construit a la volee (eval, new Function) : a relire.");
        }

        if (Str(manifest, "license") is null && !hasLicenseFile) Warn("Pas de licence (champ « license » du manifeste ou fichier LICENSE).");
        return checks;
    }

    public static string? Str(JsonObject o, string key) =>
        o[key] is JsonValue v && v.TryGetValue(out string? s) && !string.IsNullOrWhiteSpace(s) ? s.Trim() : null;

    public static List<string> StrList(JsonObject o, string key) =>
        o[key] is JsonArray a ? a.Select(x => x is JsonValue v && v.TryGetValue(out string? s) ? s : "").Where(s => s.Length > 0).ToList() : [];

    /// <summary>Compare deux versions 1.2.3 (le suffixe -beta passe avant la version sans suffixe).</summary>
    public static int CompareVersions(string a, string b)
    {
        static (int[] Nums, string? Pre) Parse(string v)
        {
            string[] parts = v.Split('-', 2);
            int[] nums = parts[0].Split('.').Select(x => int.TryParse(x, out int n) ? n : 0).ToArray();
            return (nums, parts.Length > 1 ? parts[1] : null);
        }
        var (na, pa) = Parse(a);
        var (nb, pb) = Parse(b);
        for (int i = 0; i < 3; i++)
        {
            int c = (i < na.Length ? na[i] : 0).CompareTo(i < nb.Length ? nb[i] : 0);
            if (c != 0) return c;
        }
        if (pa == pb) return 0;
        if (pa is null) return 1;
        if (pb is null) return -1;
        return string.CompareOrdinal(pa, pb);
    }

    public static int Major(string version) => int.TryParse(version.Split('.')[0], out int n) ? n : 0;
}
