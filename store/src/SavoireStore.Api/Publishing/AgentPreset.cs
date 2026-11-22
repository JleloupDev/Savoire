// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Paquet « agent » : un modele d'agent IA, sans code (ADR-033 de Savoire).
// agent.json suit AgentPreset (plugin-api, agents.ts) :
//   { "instructions": "...", "permissions": { "read": "direct", "edit": "propose", ... },
//     "budget": { "maxSteps": 30 }, "vaultScoped": false }
// La personne en fait un agent dans Savoire (Parametres > Agents) ; Savoire
// borne toujours ses droits par ceux de la personne.
using System.Text.Json;
using System.Text.Json.Nodes;

namespace SavoireStore.Publishing;

public static class AgentPreset
{
    /// <summary>Les modes qui ont un sens pour chaque action (AGENT_ACTION_MODES de plugin-api).</summary>
    public static readonly IReadOnlyDictionary<string, string[]> Modes = new Dictionary<string, string[]>
    {
        ["read"] = ["direct", "deny"],
        ["comment"] = ["direct", "ask", "deny"],
        ["edit"] = ["direct", "ask", "propose", "deny"],
        ["create"] = ["direct", "ask", "deny"],
        ["organize"] = ["direct", "ask", "deny"],
        ["delete"] = ["direct", "ask", "deny"],
        ["plugin"] = ["direct", "ask", "propose", "deny"],
        ["delegate"] = ["direct", "ask", "deny"],
    };

    /// <summary>Les bornes du budget (AgentBudget de plugin-api) : champ, maximum permis.</summary>
    public static readonly IReadOnlyDictionary<string, long> BudgetFields = new Dictionary<string, long>
    {
        ["maxSteps"] = 200,
        ["maxTokensPerRun"] = 2_000_000,
        ["maxTokensPerDay"] = 20_000_000,
        ["maxTokensPerChild"] = 2_000_000,
    };

    /// <summary>Ce que la page du paquet affiche : les droits en clair, le budget, la portee.</summary>
    public sealed record Summary(string Instructions, IReadOnlyList<KeyValuePair<string, string>> Rights,
        IReadOnlyDictionary<string, long> Budget, bool VaultScoped);

    /// <summary>Lit un agent.json deja valide (null s'il ne l'est pas).</summary>
    public static Summary? Describe(string json)
    {
        JsonObject? o;
        try { o = JsonNode.Parse(json) as JsonObject; } catch (JsonException) { return null; }
        if (o is null) return null;
        var rights = new List<KeyValuePair<string, string>>();
        if (o["permissions"] is JsonObject perms)
            foreach ((string action, JsonNode? v) in perms)
                if (Modes.ContainsKey(action) && v is JsonValue jv && jv.TryGetValue(out string? mode)) rights.Add(new(action, mode));
        var budget = new Dictionary<string, long>();
        if (o["budget"] is JsonObject b)
            foreach ((string k, JsonNode? v) in b)
                if (BudgetFields.ContainsKey(k) && v is JsonValue jv && jv.TryGetValue(out long n)) budget[k] = n;
        bool scoped = o["vaultScoped"] is JsonValue sv && sv.TryGetValue(out bool bs) && bs;
        return new Summary(PackageChecks.Str(o, "instructions") ?? "", rights, budget, scoped);
    }

    public const int MaxInstructions = 20_000;

    private static readonly string[] Writes = ["edit", "create", "organize", "delete", "plugin", "delegate"];

    public static List<Check> Check(string json)
    {
        var checks = new List<Check>();
        void Err(string m) => checks.Add(new Check(Publishing.Check.Error, m));
        void Warn(string m) => checks.Add(new Check(Publishing.Check.Warning, m));
        JsonObject? o;
        try { o = JsonNode.Parse(json) as JsonObject; }
        catch (JsonException) { o = null; }
        if (o is null) { Err("agent.json : objet JSON attendu."); return checks; }
        string? instructions = PackageChecks.Str(o, "instructions");
        if (instructions is null) Err("agent.json : « instructions » obligatoire (les consignes de l'agent).");
        else if (instructions.Length > MaxInstructions) Err($"agent.json : « instructions » de {MaxInstructions} caracteres au plus.");
        if (o["vaultScoped"] is JsonNode vs && !(vs is JsonValue vv && vv.TryGetValue(out bool _))) Err("agent.json : « vaultScoped » vaut true ou false.");
        if (o["budget"] is JsonNode b)
        {
            if (b is not JsonObject budget) Err("agent.json : « budget » est un objet.");
            else foreach ((string k, JsonNode? n) in budget)
            {
                if (!BudgetFields.TryGetValue(k, out long max)) { Err($"agent.json : champ de budget inconnu « {k} »."); continue; }
                if (!(n is JsonValue nv && nv.TryGetValue(out long val)) || val < 1 || val > max)
                    Err($"agent.json : « budget.{k} » est un entier de 1 a {max}.");
            }
        }
        if (o["permissions"] is not JsonObject perms) { Err("agent.json : « permissions » obligatoire (un mode par action)."); return checks; }
        foreach ((string action, JsonNode? value) in perms)
        {
            if (!Modes.TryGetValue(action, out string[]? allowed)) { Err($"agent.json : action inconnue « {action} »."); continue; }
            string? mode = value is JsonValue v && v.TryGetValue(out string? s) ? s : null;
            if (mode is null || !allowed.Contains(mode)) Err($"agent.json : « {action} » vaut {string.Join(", ", allowed)} (pas « {mode} »).");
            else if (mode == "direct" && Writes.Contains(action))
                Warn($"agent.json : « {action} » en direct (sans accord ni proposition) : a relire.");
        }
        return checks;
    }
}
