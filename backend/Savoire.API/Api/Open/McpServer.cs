// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Serveur MCP (Model Context Protocol) de Savoire, transport « Streamable
// HTTP » sans flux SSE : un message JSON-RPC par requete POST, une reponse
// JSON. Assez pour Claude, ChatGPT et les autres clients MCP.
//
// Outils en lecture seule (l'ecriture viendra avec un mode de jeton a part) :
// list_vaults, search, list_notes, read_note. Chacun passe par OpenGateway,
// donc par les droits de la personne et les vaults du jeton.
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Savoire.Application.Indexer;
using Savoire.Domain.Exceptions;

namespace Savoire.Server.Open;

public sealed class McpServer(OpenGateway gateway, ILogger<McpServer> logger)
{
    public const string LatestProtocol = "2025-06-18";
    private static readonly string[] Protocols = [LatestProtocol, "2025-03-26", "2024-11-05"];

    private const string Instructions =
        "Savoire : les notes Markdown de la personne, rangees dans des vaults. " +
        "Commencez par list_vaults, puis search pour trouver des notes et read_note pour les lire. " +
        "Un vault se designe par son id ou par son nom.";

    /// <summary>
    /// Traite un message. Null : c'etait une notification (pas de reponse,
    /// HTTP 202). Sinon la reponse JSON-RPC.
    /// </summary>
    public async Task<JsonObject?> HandleAsync(JsonNode? message, OpenCaller caller, CancellationToken ct)
    {
        if (message is not JsonObject msg || msg["jsonrpc"]?.GetValue<string>() != "2.0")
            return Error(null, -32600, "Requete JSON-RPC 2.0 attendue (un seul message, pas de lot).");
        JsonNode? id = msg["id"]?.DeepClone();
        string? method = msg["method"] is JsonValue m && m.TryGetValue(out string? s) ? s : null;
        // Une reponse ou une notification du client : rien a rendre.
        if (method is null || !msg.ContainsKey("id")) return null;

        JsonObject? p = msg["params"] as JsonObject;
        try
        {
            return method switch
            {
                "initialize" => Result(id, Initialize(p)),
                "ping" => Result(id, new JsonObject()),
                "tools/list" => Result(id, new JsonObject { ["tools"] = Tools() }),
                "tools/call" => Result(id, await CallToolAsync(p, caller, ct)),
                "resources/list" => Result(id, new JsonObject { ["resources"] = new JsonArray() }),
                "prompts/list" => Result(id, new JsonObject { ["prompts"] = new JsonArray() }),
                _ => Error(id, -32601, $"Methode inconnue : {method}."),
            };
        }
        catch (McpInvalidParams ex)
        {
            return Error(id, -32602, ex.Message);
        }
    }

    private static JsonObject Initialize(JsonObject? p)
    {
        string? asked = p?["protocolVersion"] is JsonValue v && v.TryGetValue(out string? s) ? s : null;
        return new JsonObject
        {
            ["protocolVersion"] = asked is not null && Protocols.Contains(asked) ? asked : LatestProtocol,
            ["capabilities"] = new JsonObject { ["tools"] = new JsonObject { ["listChanged"] = false } },
            ["serverInfo"] = new JsonObject { ["name"] = "savoire", ["title"] = "Savoire", ["version"] = "0.1.0" },
            ["instructions"] = Instructions,
        };
    }

    // ── Outils ───────────────────────────────────────────────────────────────

    private static JsonArray Tools() =>
    [
        Tool("list_vaults", "Vaults de Savoire", "Liste les vaults (espaces de notes) accessibles, avec leur id et leur nom.",
            new JsonObject(), []),
        Tool("search", "Chercher dans un vault", "Recherche plein texte dans les notes et fichiers d'un vault. Rend les notes trouvees, avec un extrait.",
            new JsonObject
            {
                ["vault"] = Str("Id ou nom du vault."),
                ["query"] = Str("Mots a chercher. Guillemets pour une expression exacte."),
                ["limit"] = Int("Nombre de resultats (1 a 50, defaut 10)."),
                ["folder"] = Str("Limiter a un dossier (ex. Projets/2026)."),
            }, ["vault", "query"]),
        Tool("list_notes", "Lister les notes", "Liste les notes d'un vault (ou d'un dossier), par chemin.",
            new JsonObject
            {
                ["vault"] = Str("Id ou nom du vault."),
                ["folder"] = Str("Dossier (facultatif)."),
                ["limit"] = Int("Nombre de notes (1 a 50, defaut 50)."),
                ["cursor"] = Str("Suite d'une liste precedente (champ next)."),
            }, ["vault"]),
        Tool("read_note", "Lire une note", "Rend le texte complet d'une note en Markdown (ou le texte d'un fichier), par son chemin ou son id.",
            new JsonObject
            {
                ["vault"] = Str("Id ou nom du vault."),
                ["path"] = Str("Chemin de la note (ex. Projets/Plan.md)."),
                ["id"] = Str("Id de la note (rendu par search ou list_notes)."),
            }, ["vault"]),
    ];

    private static JsonObject Tool(string name, string title, string description, JsonObject properties, string[] required) => new()
    {
        ["name"] = name,
        ["title"] = title,
        ["description"] = description,
        ["inputSchema"] = new JsonObject
        {
            ["type"] = "object",
            ["properties"] = properties,
            ["required"] = new JsonArray(required.Select(r => (JsonNode)JsonValue.Create(r)).ToArray()),
            ["additionalProperties"] = false,
        },
        ["annotations"] = new JsonObject { ["readOnlyHint"] = true, ["openWorldHint"] = false },
    };

    private static JsonObject Str(string description) => new() { ["type"] = "string", ["description"] = description };
    private static JsonObject Int(string description) => new() { ["type"] = "integer", ["description"] = description };

    private async Task<JsonObject> CallToolAsync(JsonObject? p, OpenCaller caller, CancellationToken ct)
    {
        string name = p?["name"] is JsonValue n && n.TryGetValue(out string? s) ? s : throw new McpInvalidParams("Nom d'outil manquant.");
        JsonObject args = p?["arguments"] as JsonObject ?? new JsonObject();
        try
        {
            return name switch
            {
                "list_vaults" => await ListVaultsAsync(caller, ct),
                "search" => await SearchAsync(args, caller, ct),
                "list_notes" => await ListNotesAsync(args, caller, ct),
                "read_note" => await ReadNoteAsync(args, caller, ct),
                _ => throw new McpInvalidParams($"Outil inconnu : {name}."),
            };
        }
        catch (Exception ex) when (ex is VaultNotFoundException or AccessDeniedException or DocumentNotFoundException)
        {
            return ToolError(ex.Message);
        }
        catch (Exception ex) when (ex is not McpInvalidParams and not OperationCanceledException)
        {
            logger.LogError(ex, "MCP : outil {Tool} en erreur.", name);
            return ToolError("Erreur interne de Savoire.");
        }
    }

    private async Task<JsonObject> ListVaultsAsync(OpenCaller caller, CancellationToken ct)
    {
        IReadOnlyList<OpenVault> vaults = await gateway.VaultsAsync(caller, ct);
        if (vaults.Count == 0) return ToolText("Aucun vault accessible avec ce jeton.");
        var sb = new StringBuilder();
        foreach (OpenVault v in vaults) sb.Append("- ").Append(v.Name).Append(" (id : ").Append(v.Id).Append(", role : ").Append(v.Role).AppendLine(")");
        return ToolText(sb.ToString());
    }

    private async Task<JsonObject> SearchAsync(JsonObject args, OpenCaller caller, CancellationToken ct)
    {
        OpenVault vault = await VaultArgAsync(args, caller, ct);
        string query = RequiredString(args, "query");
        IndexerReply reply = await gateway.SearchAsync(caller, vault.Id, query, OptInt(args, "limit"), OptString(args, "folder"), ct);
        if (reply.StatusCode != 200) return ToolError(OpenGateway.ErrorMessage(reply));
        JsonNode? result = JsonNode.Parse(reply.Json);
        JsonArray hits = result?["hits"] as JsonArray ?? [];
        if (hits.Count == 0) return ToolText($"Aucun resultat pour « {query} » dans {vault.Name}.");
        var sb = new StringBuilder();
        sb.Append(hits.Count).Append(" resultat(s) dans ").Append(vault.Name).AppendLine(" :");
        foreach (JsonNode? h in hits)
        {
            sb.Append("- ").Append(h?["title"]).Append(" — ").Append(h?["path"]).Append(" (id : ").Append(h?["id"]).AppendLine(")");
            if (h?["snippets"] is JsonArray snippets)
                foreach (JsonNode? sn in snippets.Take(2)) sb.Append("  « ").Append(sn?["text"]).AppendLine(" »");
        }
        return ToolText(sb.ToString());
    }

    private async Task<JsonObject> ListNotesAsync(JsonObject args, OpenCaller caller, CancellationToken ct)
    {
        OpenVault vault = await VaultArgAsync(args, caller, ct);
        IndexerReply reply = await gateway.ListNotesAsync(caller, vault.Id, OptString(args, "folder"), OptInt(args, "limit"), OptString(args, "cursor"), ct);
        if (reply.StatusCode != 200) return ToolError(OpenGateway.ErrorMessage(reply));
        JsonNode? result = JsonNode.Parse(reply.Json);
        JsonArray rows = result?["rows"] as JsonArray ?? [];
        var sb = new StringBuilder();
        sb.Append(result?["total"]).Append(" note(s) dans ").Append(vault.Name).AppendLine(" :");
        foreach (JsonNode? r in rows) sb.Append("- ").Append(r?["path"]).Append(" (id : ").Append(r?["id"]).AppendLine(")");
        if (result?["next"] is JsonNode next) sb.Append("Suite : cursor = ").AppendLine(next.ToString());
        return ToolText(sb.ToString());
    }

    private async Task<JsonObject> ReadNoteAsync(JsonObject args, OpenCaller caller, CancellationToken ct)
    {
        OpenVault vault = await VaultArgAsync(args, caller, ct);
        string? id = OptString(args, "id");
        string? path = OptString(args, "path");
        if (id is null && path is null) throw new McpInvalidParams("Donner path ou id.");
        IndexerReply reply = await gateway.ReadAsync(caller, vault.Id, id, path, ct);
        if (reply.StatusCode != 200) return ToolError(OpenGateway.ErrorMessage(reply));
        JsonNode? doc = JsonNode.Parse(reply.Json);
        string text = $"# {doc?["path"]}\n\n{doc?["content"]}";
        if (doc?["truncated"]?.GetValue<bool>() == true) text += "\n\n[Texte tronque : note trop longue.]";
        return ToolText(text);
    }

    private async Task<OpenVault> VaultArgAsync(JsonObject args, OpenCaller caller, CancellationToken ct)
    {
        string v = RequiredString(args, "vault");
        return await gateway.ResolveVaultAsync(caller, v, ct)
            ?? throw new VaultNotFoundException(v);
    }

    private static string RequiredString(JsonObject args, string key) =>
        OptString(args, key) ?? throw new McpInvalidParams($"Argument manquant : {key}.");

    private static string? OptString(JsonObject args, string key) =>
        args[key] is JsonValue v && v.TryGetValue(out string? s) && !string.IsNullOrWhiteSpace(s) ? s.Trim() : null;

    private static int? OptInt(JsonObject args, string key) =>
        args[key] is JsonValue v ? (v.TryGetValue(out int i) ? i : v.TryGetValue(out double d) ? (int)d : null) : null;

    private static JsonObject ToolText(string text) =>
        new() { ["content"] = new JsonArray(new JsonObject { ["type"] = "text", ["text"] = text }), ["isError"] = false };

    private static JsonObject ToolError(string message) =>
        new() { ["content"] = new JsonArray(new JsonObject { ["type"] = "text", ["text"] = message }), ["isError"] = true };

    private static JsonObject Result(JsonNode? id, JsonObject result) =>
        new() { ["jsonrpc"] = "2.0", ["id"] = id, ["result"] = result };

    public static JsonObject Error(JsonNode? id, int code, string message) =>
        new() { ["jsonrpc"] = "2.0", ["id"] = id, ["error"] = new JsonObject { ["code"] = code, ["message"] = message } };

    private sealed class McpInvalidParams(string message) : Exception(message);
}
