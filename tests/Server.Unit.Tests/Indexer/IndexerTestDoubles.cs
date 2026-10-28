// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// Doublures communes des tests du pair indexeur.

using System.Text;
using System.Text.Json.Nodes;
using Microsoft.Extensions.Options;
using NSubstitute;
using Savoire.Application.Abstractions;
using Savoire.Application.Indexer;
using Savoire.Domain.Enums;
using Savoire.Domain.ReadModels;
using Savoire.Domain.Repositories;

namespace Savoire.Server.Unit.Tests.Indexer;

internal static class IndexerTestDoubles
{
    public static IndexerOptions Options(params string[] instances) => new()
    {
        ServiceToken = "service-token",
        Instances = [.. instances.Select(n => new IndexerInstanceOptions { Name = n, Url = $"http://{n}.test:7070" })],
        RetryAfterSeconds = 7,
    };

    public static IOptionsMonitor<IndexerOptions> Monitor(IndexerOptions opts)
    {
        var monitor = Substitute.For<IOptionsMonitor<IndexerOptions>>();
        monitor.CurrentValue.Returns(opts);
        return monitor;
    }

    /// <summary>Reglages : tous les vaults en pair gere, sauf ceux donnes.</summary>
    public static IVaultIndexerSettingRepository Settings(params VaultIndexerSetting[] stored)
    {
        var settings = Substitute.For<IVaultIndexerSettingRepository>();
        VaultIndexerSetting Find(string id) => stored.FirstOrDefault(s => s.VaultId == id) ?? VaultIndexerSetting.Default(id);
        settings.GetAsync(Arg.Any<string>(), Arg.Any<CancellationToken>())
            .Returns(ci => Find(ci.Arg<string>()));
        settings.GetManyAsync(Arg.Any<IReadOnlyCollection<string>>(), Arg.Any<CancellationToken>())
            .Returns(ci => (IReadOnlyDictionary<string, VaultIndexerSetting>)ci.Arg<IReadOnlyCollection<string>>()
                .Distinct().ToDictionary(id => id, Find));
        return settings;
    }

    public static IndexerPeerResponse Answer(int status, string body, TimeSpan? retryAfter = null) =>
        new(IndexerPeerOutcome.Answered, status, body, retryAfter);

    public static IndexerPeerResponse Error(int status, string code, TimeSpan? retryAfter = null) =>
        Answer(status, IndexerReply.ErrorJson(code, "m").ToJsonString(), retryAfter);

    public static JsonObject Json(byte[] body) => JsonNode.Parse(Encoding.UTF8.GetString(body))!.AsObject();

    public static JsonObject Json(string body) => JsonNode.Parse(body)!.AsObject();

    /// <summary>Un vault en mode « none » ou « organization ».</summary>
    public static VaultIndexerSetting Mode(string vaultId, IndexerMode mode, string? url = null) => new(vaultId, mode, url);
}
