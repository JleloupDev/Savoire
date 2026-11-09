// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
using System.Text.RegularExpressions;
using Savoire.Application.Publications;
using Savoire.Domain.ReadModels;
using Savoire.Server.Publications;
using Xunit;

namespace Server.Unit.Tests.Publications;

public class PublicationTests
{
    [Fact]
    public void Adresse_lisible_et_sure_tiree_du_titre()
    {
        string slug = PublicationSlug.For("Été 2026 : Rapport / Bilan !");
        Assert.Matches(new Regex("^ete-2026-rapport-bilan-[a-z0-9]{6}$"), slug);
        Assert.Matches(new Regex("^[a-z0-9]{6}$"), PublicationSlug.For("¿¿??"));
        Assert.NotEqual(PublicationSlug.For("x"), PublicationSlug.For("x"));
    }

    [Fact]
    public void Page_publique_titre_echappe_et_noindex_si_demande()
    {
        var p = new Publication("s", "v", "d", "<b>Titre</b>", "Desc \"x\"", "<p>corps</p>", false, "u", DateTime.UtcNow, DateTime.UtcNow);
        string html = PublicPage.Render(p, "https://exemple.fr/p/s");
        Assert.Contains("<title>&lt;b&gt;Titre&lt;/b&gt;</title>", html);
        Assert.Contains("content=\"Desc &quot;x&quot;\"", html);
        Assert.Contains("noindex", html);
        Assert.Contains("<p>corps</p>", html);
    }
}
