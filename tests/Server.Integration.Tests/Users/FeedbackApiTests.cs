// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// Retours des testeurs : un compte connecte envoie, seul l'administrateur lit,
// range et supprime. Les retours partent avec le compte.

using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using FluentAssertions;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Savoire.Infrastructure.Persistence;

namespace Savoire.Server.Integration.Tests.Users;

[Collection("Integration")]
public class FeedbackApiTests : IClassFixture<AppFactory>
{
    private readonly AppFactory _factory;
    public FeedbackApiTests(AppFactory factory) => _factory = factory;

    // Plus petit PNG valide (1x1).
    private const string Png1x1 =
        "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

    private HttpClient Authed(string token)
    {
        HttpClient c = _factory.CreateClient();
        c.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", token);
        return c;
    }

    private static string Uid() => Guid.NewGuid().ToString("N")[..8];

    private async Task<T> DbAsync<T>(Func<AppDbContext, Task<T>> query)
    {
        using IServiceScope scope = _factory.Services.CreateScope();
        return await query(scope.ServiceProvider.GetRequiredService<AppDbContext>());
    }

    [Fact(DisplayName = "Sans connexion : on ne peut ni envoyer ni lire")]
    public async Task Anonymous_IsRejected()
    {
        HttpClient anon = _factory.CreateClient();
        (await anon.PostAsJsonAsync("/api/v1/feedback", new { message = "x" })).StatusCode.Should().Be(HttpStatusCode.Unauthorized);
        (await anon.GetAsync("/api/v1/admin/feedback")).StatusCode.Should().Be(HttpStatusCode.Unauthorized);
    }

    [Fact(DisplayName = "Un compte envoie un retour avec capture ; l'administrateur le lit, le range, le supprime")]
    public async Task Submit_ThenAdminReadsArchivesDeletes()
    {
        string uid = Uid();
        (string token, string userId) = await _factory.CreateUserAndGetTokenAsync($"fb-{uid}@test.com", displayName: "Testeuse");
        HttpClient me = Authed(token);

        var sent = await me.PostAsJsonAsync("/api/v1/feedback", new
        {
            message = $"Le bouton est trop petit {uid}",
            context = new { path = "/", viewport = "1280x800" },
            screenshot = Png1x1,
        });
        sent.StatusCode.Should().Be(HttpStatusCode.OK);
        string id = (await sent.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetString()!;

        // Un autre compte ne lit pas les retours.
        (await me.GetAsync("/api/v1/admin/feedback")).StatusCode.Should().Be(HttpStatusCode.Forbidden);
        (await me.GetAsync($"/api/v1/admin/feedback/{id}/screenshot")).StatusCode.Should().Be(HttpStatusCode.Forbidden);

        HttpClient admin = await _factory.CreateAdminClientAsync();
        JsonElement list = await admin.GetFromJsonAsync<JsonElement>("/api/v1/admin/feedback");
        JsonElement mine = list.EnumerateArray().Single(r => r.GetProperty("id").GetString() == id);
        mine.GetProperty("userId").GetString().Should().Be(userId);
        mine.GetProperty("userName").GetString().Should().Be("Testeuse");
        mine.GetProperty("hasScreenshot").GetBoolean().Should().BeTrue();
        mine.GetProperty("context").GetString().Should().Contain("1280x800");

        var shot = await admin.GetAsync($"/api/v1/admin/feedback/{id}/screenshot");
        shot.StatusCode.Should().Be(HttpStatusCode.OK);
        shot.Content.Headers.ContentType!.MediaType.Should().Be("image/png");

        (await admin.PostAsJsonAsync($"/api/v1/admin/feedback/{id}/archive", new { archived = true })).StatusCode.Should().Be(HttpStatusCode.NoContent);
        (await admin.GetFromJsonAsync<JsonElement>("/api/v1/admin/feedback")).EnumerateArray()
            .Should().NotContain(r => r.GetProperty("id").GetString() == id);
        (await admin.GetFromJsonAsync<JsonElement>("/api/v1/admin/feedback?archived=true")).EnumerateArray()
            .Should().Contain(r => r.GetProperty("id").GetString() == id);

        (await admin.DeleteAsync($"/api/v1/admin/feedback/{id}")).StatusCode.Should().Be(HttpStatusCode.NoContent);
        (await admin.DeleteAsync($"/api/v1/admin/feedback/{id}")).StatusCode.Should().Be(HttpStatusCode.NotFound);
    }

    [Theory(DisplayName = "Un retour vide ou une capture qui n'est pas une image est refuse")]
    [InlineData("", null)]
    [InlineData("Bonjour", "data:image/png;base64,SGVsbG8gdG91dCBsZSBtb25kZQ==")]
    [InlineData("Bonjour", "pas du base64 !")]
    public async Task Invalid_IsRejected(string message, string? screenshot)
    {
        (string token, _) = await _factory.CreateUserAndGetTokenAsync($"fb-bad-{Uid()}@test.com");
        (await Authed(token).PostAsJsonAsync("/api/v1/feedback", new { message, screenshot }))
            .StatusCode.Should().Be(HttpStatusCode.BadRequest);
    }

    [Fact(DisplayName = "Supprimer son compte efface ses retours")]
    public async Task AccountErasure_RemovesFeedback()
    {
        (string token, string userId) = await _factory.CreateUserAndGetTokenAsync($"fb-gone-{Uid()}@test.com");
        HttpClient me = Authed(token);
        (await me.PostAsJsonAsync("/api/v1/feedback", new { message = "Avant de partir" })).EnsureSuccessStatusCode();
        (await DbAsync(db => db.FeedbackReports.CountAsync(f => f.UserId == userId))).Should().Be(1);

        var deleted = await me.SendAsync(new HttpRequestMessage(HttpMethod.Delete, "/api/v1/auth/me") { Content = JsonContent.Create(new { confirm = "SUPPRIMER" }) });
        deleted.StatusCode.Should().Be(HttpStatusCode.NoContent);
        (await DbAsync(db => db.FeedbackReports.CountAsync(f => f.UserId == userId))).Should().Be(0);
    }
}
