// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// Tests unitaires : seuls les rapports d'erreur du DSN attendu sont relayes.

using System.Text;
using FluentAssertions;
using Savoire.Server.Extensions;

namespace Savoire.Server.Unit.Tests.Telemetry;

public class ErrorEnvelopeTests
{
    private const string Dsn = "https://abc123@savoire.example.org/errors/4";

    private static byte[] Envelope(string header) =>
        Encoding.UTF8.GetBytes(header + "\n{\"type\":\"event\"}\n{\"message\":\"boom\"}\n");

    [Fact]
    public void Parses_key_and_project()
    {
        ErrorEnvelope.ParseDsn(Dsn).Should().Be(("abc123", "4"));
        ErrorEnvelope.ParseDsn("https://glitchtip/4").Should().BeNull();
        ErrorEnvelope.ParseDsn("pas un dsn").Should().BeNull();
        ErrorEnvelope.ParseDsn(null).Should().BeNull();
    }

    [Fact]
    public void Routes_the_expected_dsn()
    {
        ErrorEnvelope.Route(Envelope($"{{\"dsn\":\"{Dsn}\",\"sent_at\":\"2026-11-07T10:00:00Z\"}}"), Dsn)
            .Should().Be(("abc123", "4"));
    }

    [Theory]
    [InlineData("{\"dsn\":\"https://other@savoire.example.org/errors/4\"}")]
    [InlineData("{\"dsn\":\"https://abc123@savoire.example.org/errors/5\"}")]
    [InlineData("{\"event_id\":\"x\"}")]
    [InlineData("pas du json")]
    public void Refuses_anything_else(string header)
    {
        ErrorEnvelope.Route(Envelope(header), Dsn).Should().BeNull();
    }

    [Fact]
    public void Refuses_everything_when_not_configured()
    {
        ErrorEnvelope.Route(Envelope($"{{\"dsn\":\"{Dsn}\"}}"), null).Should().BeNull();
    }
}
