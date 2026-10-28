// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// Recherche globale : fusion des pages rendues par plusieurs instances du
// pair indexeur, et curseur compose pour la page suivante.
//
// Chaque instance rend ses resultats tries par score. La fusion prend le
// meilleur score en tete des pages (a egalite : vaultId puis id, pour une
// pagination stable). Elle s'arrete quand une instance a epuise sa page mais
// en a d'autres : on ne peut pas classer ce qu'on n'a pas vu. La page rendue
// peut donc etre plus courte que « limit » ; « next » dit qu'il y a une suite.
//
// Le curseur compose garde, par instance encore active, le curseur de la page
// en cours et le nombre de resultats deja rendus de cette page. Il est opaque
// pour le client (base64url d'un JSON).

using System.Globalization;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Savoire.Application.Indexer.SearchAllVaults;

/// <summary>Ou en est une instance : curseur de la page en cours (null : premiere page), resultats deja rendus.</summary>
public sealed record GlobalSearchPart(string? Cursor, int Skip);

/// <summary>Etat d'une recherche globale entre deux pages.</summary>
public sealed record GlobalSearchCursor(IReadOnlyDictionary<string, GlobalSearchPart> Parts, bool Partial)
{
    public static GlobalSearchCursor Start(IEnumerable<string> instances) =>
        new(instances.ToDictionary(n => n, _ => new GlobalSearchPart(null, 0), StringComparer.Ordinal), false);

    public string Encode()
    {
        var parts = new JsonObject();
        foreach ((string name, GlobalSearchPart part) in Parts)
            parts[name] = new JsonObject { ["c"] = part.Cursor, ["s"] = part.Skip };
        var root = new JsonObject { ["v"] = 1, ["p"] = parts, ["x"] = Partial };
        return Convert.ToBase64String(Encoding.UTF8.GetBytes(root.ToJsonString()))
            .TrimEnd('=').Replace('+', '-').Replace('/', '_');
    }

    /// <summary>Le curseur decode, ou null s'il est illisible.</summary>
    public static GlobalSearchCursor? Decode(string cursor)
    {
        try
        {
            string b64 = cursor.Replace('-', '+').Replace('_', '/');
            b64 = b64.PadRight(b64.Length + (4 - b64.Length % 4) % 4, '=');
            if (JsonNode.Parse(Convert.FromBase64String(b64)) is not JsonObject root) return null;
            if (root["v"]?.GetValue<int>() != 1 || root["p"] is not JsonObject parts) return null;
            var result = new Dictionary<string, GlobalSearchPart>(StringComparer.Ordinal);
            foreach ((string name, JsonNode? node) in parts)
            {
                if (node is not JsonObject part) return null;
                string? c = part["c"] is JsonValue cv ? cv.GetValue<string>() : null;
                int s = part["s"]?.GetValue<int>() ?? 0;
                if (s < 0) return null;
                result[name] = new GlobalSearchPart(c, s);
            }
            bool partial = root["x"]?.GetValue<bool>() ?? false;
            return new GlobalSearchCursor(result, partial);
        }
        catch (Exception e) when (e is FormatException or JsonException or InvalidOperationException)
        {
            return null;
        }
    }
}

/// <summary>La page rendue par une instance.</summary>
public sealed record InstanceSearchPage(string Instance, GlobalSearchPart Part, IReadOnlyList<JsonObject> Hits, string? Next);

public static class GlobalSearchMerge
{
    /// <summary>
    /// Fusionne les pages. Rend les resultats (au plus <paramref name="limit"/>)
    /// et l'etat de chaque instance encore active apres cette page.
    /// </summary>
    public static (List<JsonObject> Hits, Dictionary<string, GlobalSearchPart> Remaining) Merge(
        IReadOnlyList<InstanceSearchPage> pages, int limit)
    {
        int[] pos = pages.Select(p => Math.Min(p.Part.Skip, p.Hits.Count)).ToArray();
        var hits = new List<JsonObject>();

        while (hits.Count < limit)
        {
            // Une instance a epuise sa page mais en a d'autres : impossible de
            // classer la suite sans elle, on s'arrete la.
            bool blocked = false;
            for (int i = 0; i < pages.Count; i++)
                if (pos[i] >= pages[i].Hits.Count && pages[i].Next is not null) { blocked = true; break; }
            if (blocked) break;

            int best = -1;
            for (int i = 0; i < pages.Count; i++)
            {
                if (pos[i] >= pages[i].Hits.Count) continue;
                if (best < 0 || Compare(pages[i].Hits[pos[i]], pages[best].Hits[pos[best]]) < 0) best = i;
            }
            if (best < 0) break;
            hits.Add(pages[best].Hits[pos[best]]);
            pos[best]++;
        }

        var remaining = new Dictionary<string, GlobalSearchPart>(StringComparer.Ordinal);
        for (int i = 0; i < pages.Count; i++)
        {
            InstanceSearchPage page = pages[i];
            if (pos[i] < page.Hits.Count) remaining[page.Instance] = new GlobalSearchPart(page.Part.Cursor, pos[i]);
            else if (page.Next is not null) remaining[page.Instance] = new GlobalSearchPart(page.Next, 0);
        }
        return (hits, remaining);
    }

    /// <summary>Ordre de la fusion : score decroissant, puis vaultId, puis id.</summary>
    private static int Compare(JsonObject a, JsonObject b)
    {
        int byScore = Score(b).CompareTo(Score(a));
        if (byScore != 0) return byScore;
        int byVault = string.CompareOrdinal(Text(a, "vaultId"), Text(b, "vaultId"));
        return byVault != 0 ? byVault : string.CompareOrdinal(Text(a, "id"), Text(b, "id"));
    }

    private static double Score(JsonObject hit) => Number(hit["score"]) ?? 0;

    /// <summary>Un nombre JSON, quelle que soit sa representation (lu ou construit).</summary>
    private static double? Number(JsonNode? node) =>
        node is JsonValue v && v.GetValueKind() == JsonValueKind.Number
        && double.TryParse(v.ToJsonString(), NumberStyles.Float, CultureInfo.InvariantCulture, out double d)
            ? d
            : null;

    private static string Text(JsonObject hit, string name) =>
        hit[name] is JsonValue v && v.TryGetValue(out string? s) ? s ?? "" : "";

    private static readonly string[] StatusRank = ["ready", "lagging", "building", "unavailable"];

    /// <summary>Etat d'index le moins avance parmi ceux qui ont repondu.</summary>
    public static JsonObject WorstIndex(IEnumerable<JsonObject?> states)
    {
        int rank = 0;
        double? progress = null;
        long? lagMs = null;
        foreach (JsonObject? state in states)
        {
            if (state is null) continue;
            string status = state["status"] is JsonValue sv && sv.TryGetValue(out string? s) ? s ?? "ready" : "ready";
            rank = Math.Max(rank, Math.Max(0, Array.IndexOf(StatusRank, status)));
            if (Number(state["progress"]) is double p)
                progress = progress is null ? p : Math.Min(progress.Value, p);
            if (Number(state["lagMs"]) is double l)
                lagMs = Math.Max(lagMs ?? 0, (long)l);
        }
        var index = new JsonObject { ["status"] = StatusRank[rank] };
        if (progress is not null) index["progress"] = progress;
        if (lagMs is not null) index["lagMs"] = lagMs;
        return index;
    }
}
