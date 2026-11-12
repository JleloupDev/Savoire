// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// L'API ouverte : ce que ChatGPT, Claude, un script ou n8n peuvent faire avec
// un jeton personnel. Servie par deux portes, la meme logique derriere :
//  - REST : /api/open/v1/... (OpenApiController) ;
//  - MCP  : /api/mcp (McpController).
//
// Lecture seule pour l'instant : lister les vaults, chercher, lister les
// notes, lire une note. Tout passe par le pair indexeur (CallIndexerQuery),
// avec les droits de la personne (VaultAccessBehavior) et le filtre des
// vaults du jeton. Le serveur ne lit pas les CRDT lui-meme.
using System.Security.Claims;
using System.Text.Json;
using System.Text.Json.Nodes;
using MediatR;
using Savoire.Application.Common;
using Savoire.Application.Indexer;
using Savoire.Application.Indexer.CallIndexer;
using Savoire.Application.Vaults.ListVaults;
using Savoire.Infrastructure.Auth;

namespace Savoire.Server.Open;

/// <summary>Qui appelle : la personne du jeton, et les vaults que le jeton permet.</summary>
public sealed record OpenCaller(string UserId, IReadOnlySet<string>? Vaults)
{
    public static OpenCaller From(ClaimsPrincipal user)
    {
        string userId = user.FindFirstValue("sub") ?? throw new UnauthorizedAccessException("Jeton sans personne.");
        string? vaults = user.FindFirstValue(AccessTokenAuthenticationHandler.VaultsClaim);
        return new OpenCaller(userId, vaults is null ? null : vaults.Split(',', StringSplitOptions.RemoveEmptyEntries).ToHashSet());
    }

    public bool Allows(string vaultId) => Vaults is null || Vaults.Contains(vaultId);
}

public sealed record OpenVault(string Id, string Name, string Role);

public sealed class OpenGateway(IMediator mediator)
{
    public const int MaxLimit = 50;

    public static IndexerReply ForbiddenVault() =>
        IndexerReply.Error(403, "forbidden_vault", "Ce jeton ne donne pas acces a ce vault.");

    public async Task<IReadOnlyList<OpenVault>> VaultsAsync(OpenCaller caller, CancellationToken ct)
    {
        WorkspaceDto ws = await mediator.Send(new ListVaultsQuery(caller.UserId), ct);
        return ws.Vaults.Where(v => caller.Allows(v.Id)).Select(v => new OpenVault(v.Id, v.Name, v.Role)).ToList();
    }

    /// <summary>Un vault designe par son id ou par son nom (pratique pour une IA).</summary>
    public async Task<OpenVault?> ResolveVaultAsync(OpenCaller caller, string idOrName, CancellationToken ct)
    {
        IReadOnlyList<OpenVault> vaults = await VaultsAsync(caller, ct);
        return vaults.FirstOrDefault(v => v.Id == idOrName)
            ?? vaults.FirstOrDefault(v => string.Equals(v.Name, idOrName, StringComparison.OrdinalIgnoreCase));
    }

    public Task<IndexerReply> CallAsync(OpenCaller caller, string vaultId, string capability, string method, JsonNode parameters, CancellationToken ct)
    {
        if (!caller.Allows(vaultId)) return Task.FromResult(ForbiddenVault());
        return mediator.Send(new CallIndexerQuery(caller.UserId, vaultId, capability, method, parameters.ToJsonString()), ct);
    }

    public Task<IndexerReply> SearchAsync(OpenCaller caller, string vaultId, string text, int? limit, string? folder, CancellationToken ct)
    {
        var p = new JsonObject { ["text"] = text, ["limit"] = Clamp(limit, 10) };
        if (!string.IsNullOrEmpty(folder)) p["folder"] = folder;
        return CallAsync(caller, vaultId, "search", "run", p, ct);
    }

    public Task<IndexerReply> ListNotesAsync(OpenCaller caller, string vaultId, string? folder, int? limit, string? cursor, CancellationToken ct)
    {
        var from = new JsonObject { ["notes"] = true };
        if (!string.IsNullOrEmpty(folder)) from["folder"] = folder;
        var p = new JsonObject
        {
            ["from"] = from,
            ["sort"] = new JsonArray(new JsonObject { ["field"] = new JsonObject { ["doc"] = "path" } }),
            ["limit"] = Clamp(limit, MaxLimit),
        };
        if (!string.IsNullOrEmpty(cursor)) p["cursor"] = cursor;
        return CallAsync(caller, vaultId, "query", "run", p, ct);
    }

    public Task<IndexerReply> ReadAsync(OpenCaller caller, string vaultId, string? id, string? path, CancellationToken ct)
    {
        var p = new JsonObject();
        if (!string.IsNullOrEmpty(id)) p["id"] = id;
        else p["path"] = path ?? "";
        return CallAsync(caller, vaultId, "documents", "read", p, ct);
    }

    private static int Clamp(int? limit, int fallback) => Math.Clamp(limit ?? fallback, 1, MaxLimit);

    /// <summary>Le message d'erreur d'une reponse du relais ({ error: { message } }).</summary>
    public static string ErrorMessage(IndexerReply reply)
    {
        try
        {
            using JsonDocument doc = JsonDocument.Parse(reply.Json);
            if (doc.RootElement.TryGetProperty("error", out JsonElement e) && e.TryGetProperty("message", out JsonElement m))
                return m.GetString() ?? "Erreur.";
        }
        catch (JsonException) { }
        return $"Erreur {reply.StatusCode}.";
    }
}
