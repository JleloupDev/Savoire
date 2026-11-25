// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Le site : captures d'ecran, filtres et categories, connexion au site et
// avis donnes depuis le navigateur (formulaires, jeton anti-CSRF).
using System.Net;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using FluentAssertions;
using Microsoft.AspNetCore.Authentication.JwtBearer;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;

namespace SavoireStore.Tests;

/// <summary>Faux point de jeton de l'IdP : le code « sub:nom » donne un jeton pour ce compte.</summary>
public sealed class FakeTokenEndpoint : HttpMessageHandler
{
    public List<Dictionary<string, string>> Requests { get; } = [];

    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
    {
        if (request.RequestUri!.AbsoluteUri != SiteStoreFactory.TokenEndpoint) return new HttpResponseMessage(HttpStatusCode.NotFound);
        var form = (await request.Content!.ReadAsStringAsync(ct)).Split('&').Select(p => p.Split('=', 2))
            .ToDictionary(p => Uri.UnescapeDataString(p[0]), p => Uri.UnescapeDataString(p[1].Replace('+', ' ')));
        Requests.Add(form);
        if (!form.TryGetValue("code", out string? code) || !code.StartsWith("sub:") || form.GetValueOrDefault("code_verifier") is not { Length: > 20 })
            return new HttpResponseMessage(HttpStatusCode.BadRequest);
        string[] parts = code["sub:".Length..].Split(':', 2);
        string body = JsonSerializer.Serialize(new { access_token = StoreFactory.Token(parts[0], parts.Length > 1 ? parts[1] : "Quelqu'un"), token_type = "Bearer" });
        return new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(body, Encoding.UTF8, "application/json") };
    }
}

public class SiteStoreFactory : StoreFactory
{
    public const string AuthorizationEndpoint = "https://idp.test/oauth/v2/authorize";
    public const string TokenEndpoint = "https://idp.test/oauth/v2/token";
    public FakeTokenEndpoint Idp { get; } = new();

    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        base.ConfigureWebHost(builder);
        builder.ConfigureAppConfiguration(c => c.AddInMemoryCollection(new Dictionary<string, string?> { ["Auth:ClientId"] = "store-web" }));
        builder.ConfigureTestServices(services =>
        {
            services.PostConfigure<JwtBearerOptions>(JwtBearerDefaults.AuthenticationScheme, o =>
            {
                o.Configuration!.AuthorizationEndpoint = AuthorizationEndpoint;
                o.Configuration.TokenEndpoint = TokenEndpoint;
            });
            services.AddHttpClient(SavoireStore.Auth.SiteAuth.HttpClientName).ConfigurePrimaryHttpMessageHandler(() => Idp);
        });
    }
}

public partial class SiteTests : IClassFixture<SiteStoreFactory>
{
    private readonly SiteStoreFactory _f;
    public SiteTests(SiteStoreFactory f) => _f = f;

    private static string Uid() => Guid.NewGuid().ToString("N")[..8];

    /// <summary>L'en-tete d'un PNG (le store ne lit que la signature et IHDR).</summary>
    private static byte[] Png(int width, int height)
    {
        var b = new byte[64];
        new byte[] { 0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 13 }.CopyTo(b, 0);
        "IHDR"u8.ToArray().CopyTo(b, 12);
        System.Buffers.Binary.BinaryPrimitives.WriteUInt32BigEndian(b.AsSpan(16), (uint)width);
        System.Buffers.Binary.BinaryPrimitives.WriteUInt32BigEndian(b.AsSpan(20), (uint)height);
        return b;
    }

    private static Dictionary<string, string> Files(string id, string extra = "", string categories = "\"Organisation\"") => new()
    {
        ["manifest.json"] = $$"""{"id":"{{id}}","name":"Tableau {{id}}","version":"1.0.0","description":"Des tableaux pour {{id}}.","author":"Ada","license":"MIT","permissions":["vault:read"],"categories":[{{categories}}]{{extra}}}""",
        ["main.js"] = "module.exports = { onload() {} }",
    };

    private async Task<(string Id, string Publisher)> ListedAsync(string extra = "", Dictionary<string, byte[]>? binary = null, string categories = "\"Organisation\"")
    {
        string id = "site-" + Uid(), repo = "ada/" + id, publisher = "pub-" + Uid();
        _f.GitHub.Release(repo, "1.0.0", Files(id, extra, categories), binary);
        var resp = await _f.As(publisher, "Ada").PostAsJsonAsync("/api/v1/publish", new { repo });
        resp.StatusCode.Should().Be(HttpStatusCode.OK, await resp.Content.ReadAsStringAsync());
        JsonArray queue = (await _f.As(StoreFactory.AdminSubject).GetFromJsonAsync<JsonArray>("/api/v1/admin/queue"))!;
        string versionId = queue.Single(q => q!["itemId"]!.GetValue<string>() == id)!["versionId"]!.GetValue<string>();
        (await _f.As(StoreFactory.AdminSubject).PostAsync($"/api/v1/admin/versions/{versionId}/approve", null)).StatusCode.Should().Be(HttpStatusCode.NoContent);
        return (id, publisher);
    }

    [Fact(DisplayName = "Icone et captures : prises dans la release, servies par /media, montrees sur la fiche")]
    public async Task Screenshots_Published()
    {
        (string id, _) = await ListedAsync(
            ""","icon":"icon.png","screenshots":["un.png",{"file":"deux.png","caption":"Le tableau en sombre"}]""",
            new() { ["icon.png"] = Png(128, 128), ["un.png"] = Png(1600, 1000), ["deux.png"] = Png(1280, 800) });

        JsonObject detail = (await _f.CreateClient().GetFromJsonAsync<JsonObject>($"/api/v1/items/{id}"))!;
        string iconId = detail["item"]!["iconId"]!.GetValue<string>();
        JsonArray shots = detail["screenshots"]!.AsArray();
        shots.Should().HaveCount(2);
        shots[0]!["width"]!.GetValue<int>().Should().Be(1600);
        shots[1]!["caption"]!.GetValue<string>().Should().Be("Le tableau en sombre");

        var media = await _f.CreateClient().GetAsync($"/media/{shots[0]!["id"]}");
        media.StatusCode.Should().Be(HttpStatusCode.OK);
        media.Content.Headers.ContentType!.MediaType.Should().Be("image/png");
        media.Headers.GetValues("X-Content-Type-Options").Should().Contain("nosniff");
        (await _f.CreateClient().GetAsync($"/media/{Guid.NewGuid()}")).StatusCode.Should().Be(HttpStatusCode.NotFound);

        string html = await _f.CreateClient().GetStringAsync($"/items/{id}");
        html.Should().Contain($"src=\"/media/{shots[0]!["id"]}\"").And.Contain("id=\"capture-2\"").And.Contain("Le tableau en sombre")
            .And.Contain($"src=\"/media/{iconId}\"");
    }

    [Fact(DisplayName = "Images refusees : manquante, pas une image (SVG), trop de captures")]
    public async Task Screenshots_Rejected()
    {
        async Task<JsonObject> Publish(string extra, Dictionary<string, byte[]> binary)
        {
            string id = "site-" + Uid(), repo = "ada/" + id;
            _f.GitHub.Release(repo, "1.0.0", Files(id, extra), binary);
            HttpResponseMessage resp = await _f.As("pub-" + Uid()).PostAsJsonAsync("/api/v1/publish", new { repo });
            resp.StatusCode.Should().Be(HttpStatusCode.UnprocessableEntity);
            return (await resp.Content.ReadFromJsonAsync<JsonObject>())!["result"]!.AsObject();
        }
        static string Errors(JsonObject r) => string.Join("\n", r["checks"]!.AsArray().Where(c => c!["level"]!.GetValue<string>() == "error").Select(c => c!["message"]!.GetValue<string>()));

        JsonObject missing = await Publish(""","screenshots":["absente.png"]""", []);
        missing["status"]!.GetValue<string>().Should().Be("rejected");
        Errors(missing).Should().Contain("absente.png");

        JsonObject svg = await Publish(""","icon":"icon.png" """, new() { ["icon.png"] = "<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>"u8.ToArray() });
        svg["status"]!.GetValue<string>().Should().Be("rejected");
        Errors(svg).Should().Contain("PNG, JPEG ou WebP");

        string many = string.Join(",", Enumerable.Range(1, 9).Select(i => $"\"c{i}.png\""));
        JsonObject tooMany = await Publish($",\"screenshots\":[{many}]", Enumerable.Range(1, 9).ToDictionary(i => $"c{i}.png", _ => Png(800, 600)));
        tooMany["status"]!.GetValue<string>().Should().Be("rejected");
        Errors(tooMany).Should().Contain("8 captures");
    }

    [Fact(DisplayName = "Categories en slug ; filtres par categorie et par note ; comptes des facettes")]
    public async Task Filters_And_Facets()
    {
        string tag = "cat" + Uid();
        (string a, _) = await ListedAsync(categories: $"\"Écriture {tag}\"");
        (string b, _) = await ListedAsync(categories: $"\"ecriture-{tag}\", \"Organisation\"");
        string slug = "ecriture-" + tag;

        JsonObject page = (await _f.CreateClient().GetFromJsonAsync<JsonObject>($"/api/v1/items?category={slug}"))!;
        page["items"]!.AsArray().Select(i => i!["id"]!.GetValue<string>()).Should().BeEquivalentTo([a, b]);
        page["items"]![0]!["categories"]!.AsArray().Select(c => c!.GetValue<string>()).Should().Contain(slug);

        (await _f.As("lecteur-" + Uid()).PostAsJsonAsync($"/api/v1/items/{a}/reviews", new { rating = 5 })).EnsureSuccessStatusCode();
        (await _f.As("lecteur-" + Uid()).PostAsJsonAsync($"/api/v1/items/{b}/reviews", new { rating = 2 })).EnsureSuccessStatusCode();
        JsonObject good = (await _f.CreateClient().GetFromJsonAsync<JsonObject>($"/api/v1/items?category={slug}&minRating=4"))!;
        good["items"]!.AsArray().Select(i => i!["id"]!.GetValue<string>()).Should().Equal(a);

        JsonObject facets = (await _f.CreateClient().GetFromJsonAsync<JsonObject>($"/api/v1/facets?category={slug}"))!;
        facets["kinds"]!["plugin"]!.GetValue<int>().Should().Be(2);
        facets["free"]!.GetValue<int>().Should().Be(2);
        JsonArray categories = (await _f.CreateClient().GetFromJsonAsync<JsonArray>("/api/v1/categories"))!;
        categories.Single(c => c!["slug"]!.GetValue<string>() == slug)!["count"]!.GetValue<int>().Should().Be(2);

        // Le site : la page de la categorie et la recherche par texte.
        string html = await _f.CreateClient().GetStringAsync($"/categories/{slug}?minRating=4");
        html.Should().Contain($"/items/{a}\"").And.NotContain($"/items/{b}\"");
        (await _f.CreateClient().GetStringAsync($"/catalogue?q={a}")).Should().Contain($"/items/{a}\"");
        (await _f.CreateClient().GetStringAsync($"/?q={a}")).Should().Contain($"/items/{a}\"");
    }

    [Fact(DisplayName = "Pages du site : accueil, catalogue, categories, publier, sitemap ; en-tetes de securite")]
    public async Task Pages_Render()
    {
        (string id, _) = await ListedAsync();
        HttpClient client = _f.CreateClient();
        foreach (string path in new[] { "/", "/catalogue", "/catalogue?kind=plugin&sort=recent&page=2", "/categories", "/categories/organisation", "/publier", $"/items/{id}" })
        {
            HttpResponseMessage resp = await client.GetAsync(path);
            resp.StatusCode.Should().Be(HttpStatusCode.OK, path);
            resp.Headers.GetValues("Content-Security-Policy").Single().Should().Contain("default-src 'none'").And.NotContain("script-src");
        }
        (await client.GetStringAsync("/publier")).Should().Contain("<h1").And.Contain("manifest.json");
        (await client.GetStringAsync("/sitemap.xml")).Should().Contain($"/items/{id}</loc>");
        (await client.GetAsync("/site.css")).Content.Headers.ContentType!.MediaType.Should().Be("text/css");
        (await client.GetAsync("/items/inconnu-" + Uid())).StatusCode.Should().Be(HttpStatusCode.NotFound);
    }

    [GeneratedRegex("name=\"_csrf\" value=\"([^\"]+)\"")]
    private static partial Regex CsrfField();

    private HttpClient Browser() => _f.CreateClient(new WebApplicationFactoryClientOptions { AllowAutoRedirect = false, HandleCookies = true });

    /// <summary>Se connecter au site comme le ferait un navigateur, revenir sur `returnUrl`.</summary>
    private static async Task SignInAsync(HttpClient browser, string subject, string name, string returnUrl)
    {
        HttpResponseMessage login = await browser.GetAsync($"/auth/login?returnUrl={Uri.EscapeDataString(returnUrl)}");
        login.StatusCode.Should().Be(HttpStatusCode.Redirect);
        Uri authorize = login.Headers.Location!;
        authorize.GetLeftPart(UriPartial.Path).Should().Be(SiteStoreFactory.AuthorizationEndpoint);
        var query = Microsoft.AspNetCore.WebUtilities.QueryHelpers.ParseQuery(authorize.Query);
        query["client_id"].ToString().Should().Be("store-web");
        query["code_challenge_method"].ToString().Should().Be("S256");
        query["redirect_uri"].ToString().Should().EndWith("/auth/callback");
        HttpResponseMessage callback = await browser.GetAsync($"/auth/callback?code={Uri.EscapeDataString($"sub:{subject}:{name}")}&state={query["state"]}");
        callback.StatusCode.Should().Be(HttpStatusCode.Redirect);
        callback.Headers.Location!.OriginalString.Should().Be(returnUrl);
    }

    private static async Task<string> CsrfAsync(HttpClient browser, string path)
    {
        string html = await browser.GetStringAsync(path);
        return CsrfField().Match(html).Groups[1].Value;
    }

    [Fact(DisplayName = "Avis depuis le site : connexion OIDC, formulaire avec jeton, reponse de l'editeur")]
    public async Task Review_FromSite()
    {
        (string id, string publisher) = await ListedAsync();
        string item = $"/items/{id}";

        // Sans compte : un lien de connexion, pas de formulaire ; un envoi renvoie a la connexion.
        HttpClient anonymous = Browser();
        string page = await anonymous.GetStringAsync(item);
        page.Should().Contain("/auth/login?returnUrl=").And.NotContain("name=\"rating\"");
        HttpResponseMessage blind = await anonymous.PostAsync($"{item}/avis", new FormUrlEncodedContent(new Dictionary<string, string> { ["rating"] = "5" }));
        blind.Headers.Location!.OriginalString.Should().StartWith("/auth/login");

        // Mauvais etat au retour : refuse.
        HttpClient lost = Browser();
        await lost.GetAsync("/auth/login");
        (await lost.GetAsync("/auth/callback?code=sub:x&state=faux")).Headers.Location!.OriginalString.Should().Contain("connexion-echouee");

        // Connexion puis avis.
        HttpClient lou = Browser();
        string reader = "lou-" + Uid();
        await SignInAsync(lou, reader, "Lou", item);
        _f.Idp.Requests.Last()["code_verifier"].Should().NotBeNullOrEmpty();
        string csrf = await CsrfAsync(lou, item);
        csrf.Should().NotBeEmpty();

        // Sans jeton anti-CSRF : refuse.
        HttpResponseMessage forged = await lou.PostAsync($"{item}/avis", new FormUrlEncodedContent(new Dictionary<string, string> { ["rating"] = "1" }));
        forged.Headers.Location!.OriginalString.Should().Contain("n=session");

        HttpResponseMessage sent = await lou.PostAsync($"{item}/avis", new FormUrlEncodedContent(new Dictionary<string, string>
        {
            ["_csrf"] = csrf, ["rating"] = "4", ["text"] = "Très pratique au quotidien.",
        }));
        sent.StatusCode.Should().Be(HttpStatusCode.SeeOther);
        sent.Headers.Location!.OriginalString.Should().Be($"{item}?n=avis-ok#avis");
        JsonObject reviews = (await _f.CreateClient().GetFromJsonAsync<JsonObject>($"/api/v1/items/{id}/reviews"))!;
        reviews["count"]!.GetValue<int>().Should().Be(1);
        JsonNode review = reviews["reviews"]![0]!;
        review["userName"]!.GetValue<string>().Should().Be("Lou");
        review["rating"]!.GetValue<int>().Should().Be(4);
        reviews["distribution"]!.AsArray().Select(x => x!.GetValue<int>()).Should().Equal(0, 0, 0, 1, 0);
        (await lou.GetStringAsync(item)).Should().Contain("Modifier votre avis").And.Contain("Votre avis</span>");

        // L'editeur : pas d'avis sur son element, mais une reponse.
        HttpClient ada = Browser();
        await SignInAsync(ada, publisher, "Ada", item);
        string adaPage = await ada.GetStringAsync(item);
        adaPage.Should().NotContain("name=\"rating\"").And.Contain("/reponse\"");
        string adaCsrf = CsrfField().Match(adaPage).Groups[1].Value;
        string reviewId = review["id"]!.GetValue<string>();
        (await ada.PostAsync($"{item}/avis", new FormUrlEncodedContent(new Dictionary<string, string> { ["_csrf"] = adaCsrf, ["rating"] = "5" })))
            .Headers.Location!.OriginalString.Should().Contain("n=avis-refuse");
        (await ada.PostAsync($"{item}/avis/{reviewId}/reponse", new FormUrlEncodedContent(new Dictionary<string, string> { ["_csrf"] = adaCsrf, ["text"] = "Merci Lou !" })))
            .Headers.Location!.OriginalString.Should().Contain("n=reponse-ok");
        (await _f.CreateClient().GetFromJsonAsync<JsonObject>($"/api/v1/items/{id}/reviews"))!["reviews"]![0]!["reply"]!.GetValue<string>().Should().Be("Merci Lou !");

        // Lou retire son avis ; puis se deconnecte.
        string louCsrf = await CsrfAsync(lou, item);
        (await lou.PostAsync($"{item}/avis/{reviewId}/retirer", new FormUrlEncodedContent(new Dictionary<string, string> { ["_csrf"] = louCsrf })))
            .Headers.Location!.OriginalString.Should().Contain("n=avis-retire");
        (await _f.CreateClient().GetFromJsonAsync<JsonObject>($"/api/v1/items/{id}/reviews"))!["count"]!.GetValue<int>().Should().Be(0);
        (await lou.PostAsync("/auth/logout", new FormUrlEncodedContent(new Dictionary<string, string> { ["_csrf"] = louCsrf, ["returnUrl"] = item })))
            .Headers.Location!.OriginalString.Should().Be(item);
        (await lou.GetStringAsync(item)).Should().Contain("Se connecter");
    }

    [Fact(DisplayName = "Le cookie du site ne vaut pas pour l'API ; retour de connexion hors du site refuse")]
    public async Task Cookie_NotForApi()
    {
        (string id, _) = await ListedAsync();
        HttpClient browser = Browser();
        await SignInAsync(browser, "zoe-" + Uid(), "Zoé", "/");
        (await browser.PostAsJsonAsync($"/api/v1/items/{id}/reviews", new { rating = 5 })).StatusCode.Should().Be(HttpStatusCode.Unauthorized);

        SavoireStore.Auth.SiteAuth.SafeReturn("//evil.example/x").Should().Be("/");
        SavoireStore.Auth.SiteAuth.SafeReturn("https://evil.example").Should().Be("/");
        SavoireStore.Auth.SiteAuth.SafeReturn("/\\evil.example").Should().Be("/");
        SavoireStore.Auth.SiteAuth.SafeReturn("/items/x#avis").Should().Be("/items/x#avis");
    }

    [Fact(DisplayName = "Markdown des descriptions : rien de l'HTML de l'editeur ne passe")]
    public void Markdown_Escapes()
    {
        string html = SavoireStore.Site.Markdown.ToHtml("""
            # Titre <script>alert(1)</script>

            Du **gras**, du `code <b>`, un [lien](javascript:alert(1)) et un [vrai](https://exemple.org).

            - un
            - deux

            | A | B |
            |---|---|
            | `x | y` | 2 |
            """);
        html.Should().NotContain("<script>").And.Contain("&lt;script&gt;").And.Contain("<strong>gras</strong>")
            .And.Contain("<code>code &lt;b&gt;</code>").And.NotContain("javascript:").And.Contain("href=\"https://exemple.org\"")
            .And.Contain("<li>un</li><li>deux</li>").And.Contain("<td><code>x | y</code></td>");

        // Listes imbriquees, et texte (code, gras) sur plusieurs lignes.
        string nested = SavoireStore.Site.Markdown.ToHtml("1. Premier :\n   - a\n   - b\n2. Un **seul\n   fichier** `x =\n   y`\n\nDu **gras\nsur deux** lignes.");
        nested.Should().Contain("<ol><li>Premier :<ul><li>a</li><li>b</li></ul></li><li>Un <strong>seul fichier</strong> <code>x = y</code></li></ol>")
            .And.Contain("<p>Du <strong>gras sur deux</strong> lignes.</p>");
    }
}
