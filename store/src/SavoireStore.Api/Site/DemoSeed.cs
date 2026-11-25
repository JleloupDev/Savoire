// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Un catalogue de demonstration, pour voir le site en developpement
// (Store:DemoSeed=true, environnement Development seulement). Des elements
// fictifs, publies par « demo-seed », avec des avis. Captures : les images PNG
// d'un dossier (Store:DemoImages, ex. ../docs/captures/captures).
// Relance sans risque : rien n'est cree si la demonstration est deja la.
using System.Text.Json.Nodes;
using Microsoft.EntityFrameworkCore;
using SavoireStore.Data;
using SavoireStore.Publishing;
using SavoireStore.Signing;

namespace SavoireStore.Site;

public static class DemoSeed
{
    public const string Publisher = "demo-seed";

    private sealed record Demo(
        string Id, string Kind, string Name, string Summary, string Author, string[] Categories, string[] Permissions,
        string[] Shots, int Downloads, int[] Ratings, string Version = "1.2.0", string[]? Capabilities = null, int? PriceCents = null, string? Long = null);

    private static readonly Demo[] Demos =
    [
        new("kanban", "plugin", "Kanban", "Des tableaux kanban dans vos notes, en temps réel à plusieurs.", "Atelier Ada", ["organisation", "collaboration"],
            ["vault:read", "vault:write", "ui:editor"], ["03-kanban.png", "04-tableau-sombre.png"], 4210, [5, 5, 4, 5, 4, 5, 3, 5], "2.3.1", ["realtime", "versions", "search"],
            Long: """
                Organisez vos projets **sans quitter vos notes**. Chaque tableau est un fichier `.kanban` du vault : il se synchronise, se versionne et se partage comme une note.

                ## Ce qu'il sait faire

                - Colonnes et cartes en glisser-déposer
                - Édition à plusieurs en temps réel
                - Dates d'échéance, étiquettes, cases à cocher
                - Une carte peut ouvrir une note liée (`[[Ma note]]`)

                ## Raccourcis

                | Touche | Action |
                |---|---|
                | `N` | Nouvelle carte |
                | `Entrée` | Ouvrir la carte |
                | `Suppr` | Archiver |

                > Astuce : un tableau s'intègre dans une note avec `![[Projet.kanban]]`.
                """),
        new("graphe-3d", "plugin", "Graphe en 3D", "Parcourez les liens de votre vault dans un graphe en trois dimensions.", "Noé Martin", ["visualisation"],
            ["vault:read", "ui:editor"], ["05-graphe.png"], 2875, [5, 4, 4, 5, 5], "1.4.0", ["links", "index"]),
        new("theme-sepia", "plugin", "Thème Sépia", "Une palette chaude et douce pour lire longtemps sans fatigue.", "Camille Durand", ["apparence"],
            ["ui:settings"], ["06-note-sepia.png", "01-note-claire.png"], 1980, [5, 5, 4, 4]),
        new("nuit-profonde", "plugin", "Nuit profonde", "Un thème sombre à fort contraste, pensé pour l'écriture de nuit.", "Camille Durand", ["apparence"],
            ["ui:settings"], ["02-note-sombre.png"], 1544, [4, 5, 4]),
        new("diaporama-plus", "plugin", "Diaporama+", "Des transitions, des thèmes et un minuteur pour vos présentations.", "Studio Lumen", ["ecriture", "visualisation"],
            ["vault:read", "ui:editor"], ["07-diapositive.png"], 963, [4, 4, 5, 3], "0.9.2", ["modules"]),
        new("gabarits-dessin", "plugin", "Gabarits de dessin", "Des formes prêtes à l'emploi pour vos schémas : flèches, bulles, icônes.", "Studio Lumen", ["visualisation"],
            ["vault:read", "vault:write"], ["09-dessin.png"], 702, [5, 4], "1.0.3"),
        new("pomodoro", "plugin", "Minuteur Pomodoro", "Des sessions de 25 minutes, des pauses, et le temps passé par note.", "Léa Bernard", ["productivite"],
            ["vault:read", "ui:editor"], [], 3120, [5, 4, 5, 5, 4, 4], "3.0.0"),
        new("traduction", "plugin", "Traduction", "Traduisez un passage ou une note entière, sans quitter l'éditeur.", "Polyglotte", ["ia", "ecriture"],
            ["vault:read", "vault:write", "network:api.deepl.com"], [], 1405, [4, 3, 5, 4], "1.1.0", ["ai-local"], 499),
        new("citations", "plugin", "Citations et sources", "Gérez votre bibliographie et citez vos sources en deux touches.", "Bibliothèque ouverte", ["recherche", "ecriture"],
            ["vault:read", "vault:write"], [], 2260, [5, 5, 5, 4, 4], "2.0.0", ["search", "index"]),
        new("export-pdf", "plugin", "Export PDF soigné", "Exportez une note ou un dossier en PDF avec une vraie mise en page.", "Atelier Ada", ["import-export"],
            ["vault:read"], [], 1810, [4, 4, 3, 5]),
        new("import-markdown", "plugin", "Import Markdown", "Importez un dossier de fichiers Markdown, liens et images compris.", "Noé Martin", ["import-export"],
            ["vault:write"], [], 890, [4, 5]),
        new("journal-quotidien", "template", "Journal quotidien", "Une page par jour : humeur, trois priorités, gratitude et notes.", "Léa Bernard", ["organisation", "ecriture"],
            [], [], 3650, [5, 5, 4, 5, 5, 4, 5]),
        new("compte-rendu", "template", "Compte rendu de réunion", "Participants, ordre du jour, décisions et actions, prêts à remplir.", "Polyglotte", ["collaboration", "organisation"],
            [], [], 2140, [4, 4, 5]),
        new("fiche-lecture", "template", "Fiche de lecture", "Résumé, citations, avis : tout ce qu'il faut retenir d'un livre.", "Bibliothèque ouverte", ["lecture", "enseignement"],
            [], [], 1290, [5, 4, 5]),
        new("frise", "module", "Frise chronologique", "Une frise intégrable dans vos notes, à partir d'une simple liste de dates.", "Studio Lumen", ["visualisation", "enseignement"],
            [], [], 760, [4, 5, 4]),
        new("relecteur", "agent", "Relecteur bienveillant", "Un agent qui relit vos textes et propose des corrections, sans rien imposer.", "Atelier Ada", ["ia", "ecriture"],
            [], [], 1120, [5, 4, 5, 4]),
        new("resumeur", "agent", "Résumeur de réunions", "Transforme des notes de réunion en résumé clair, avec les actions à mener.", "Polyglotte", ["ia", "collaboration"],
            [], [], 640, [4, 4]),
        new("aide-memoire-latex", "notes", "Aide-mémoire LaTeX", "Quarante notes pour écrire des formules : symboles, matrices, alignements.", "Bibliothèque ouverte", ["enseignement", "developpement"],
            [], [], 980, [5, 5, 4]),
    ];

    private static readonly Dictionary<string, string> Captions = new()
    {
        ["01-note-claire.png"] = "Une note en thème clair",
        ["02-note-sombre.png"] = "Le thème sombre, pour écrire le soir",
        ["03-kanban.png"] = "Un tableau de projet",
        ["04-tableau-sombre.png"] = "Le même tableau, en sombre",
        ["05-graphe.png"] = "Les liens entre vos notes",
        ["06-note-sepia.png"] = "Une note en sépia",
        ["07-diapositive.png"] = "Une diapositive",
        ["09-dessin.png"] = "Un schéma fait avec les gabarits",
    };

    private static readonly (string Name, string Text)[] Voices =
    [
        ("Lou", "Exactement ce qu'il me fallait. Simple et rapide."),
        ("Marius", "Très bien fait, je l'utilise tous les jours."),
        ("Inès", "Pratique, même si quelques réglages manquent encore."),
        ("Hugo", "Installé en deux secondes, aucun souci."),
        ("Zoé", "Belle finition. Merci pour le travail !"),
        ("Rayan", "Bonne idée, mais la documentation pourrait être plus claire."),
        ("Chloé", "Je recommande. Il s'intègre parfaitement à mon vault."),
        ("Paul", ""),
    ];

    public static async Task RunAsync(IServiceProvider services, string? imagesDir)
    {
        StoreDb db = services.GetRequiredService<StoreDb>();
        PackageSigner signer = services.GetRequiredService<PackageSigner>();
        if (await db.Items.AnyAsync(i => i.PublisherId == Publisher)) return;
        DateTime now = DateTime.UtcNow;
        int n = 0;
        foreach (Demo d in Demos)
        {
            n++;
            DateTime created = now.AddDays(-90 + n * 4);
            var manifest = new JsonObject
            {
                ["id"] = d.Id, ["kind"] = d.Kind, ["name"] = d.Name, ["version"] = d.Version, ["description"] = d.Summary,
                ["author"] = d.Author, ["license"] = "MIT", ["permissions"] = new JsonArray(d.Permissions.Select(p => (JsonNode)p).ToArray()),
                ["categories"] = new JsonArray(d.Categories.Select(c => (JsonNode)c).ToArray()),
            };
            if (d.Capabilities is not null) manifest["capabilities"] = new JsonArray(d.Capabilities.Select(c => (JsonNode)c).ToArray());
            if (d.Long is not null) manifest["longDescription"] = d.Long;
            var files = new SortedDictionary<string, string>(StringComparer.Ordinal);
            switch (d.Kind)
            {
                case "template": files["template.md"] = $"# {d.Name}\n\n"; break;
                case "module": files["module.md"] = $"# {d.Name}\n"; break;
                case "notes": files["notes/LaTeX/Symboles.md"] = "# Symboles\n"; break;
                case "agent":
                    files["agent.json"] = """{"instructions":"Relisez le texte demande. Proposez des corrections en mode revision, expliquez chacune en une phrase. Ne changez jamais le sens.","permissions":{"read":"direct","comment":"direct","edit":"propose"},"budget":{"maxSteps":40}}""";
                    break;
                default: files["main.js"] = "module.exports = { onload() {}, onunload() {} }"; break;
            }
            var item = new Item
            {
                Id = d.Id, Kind = d.Kind, Name = d.Name, Summary = d.Summary, Description = d.Long ?? d.Summary, Author = d.Author,
                PublisherId = Publisher, Repo = $"demo/{d.Id}", License = "MIT", Homepage = "https://example.org",
                Categories = d.Categories.ToList(), Status = ItemStatus.Listed, LatestVersion = d.Version,
                PriceCents = d.PriceCents, Currency = d.PriceCents is null ? null : "EUR", Downloads = d.Downloads,
                CreatedAt = created, UpdatedAt = created.AddDays(n % 5),
            };
            db.Items.Add(item);
            // Deux versions : l'ancienne, puis l'actuelle.
            foreach ((string version, DateTime at) in new[] { ("1.0.0", created), (d.Version, item.UpdatedAt) }.DistinctBy(v => v.Item1))
            {
                manifest["version"] = version;
                byte[] package = PublishService.BuildPackage(d.Id, d.Kind, version, manifest, files);
                var v = new ItemVersion
                {
                    Id = Guid.NewGuid(), ItemId = d.Id, Version = version, Manifest = manifest.ToJsonString(), Package = package,
                    Sha256 = PackageSigner.Sha256(package), Signature = signer.Sign(package), Permissions = d.Permissions.ToList(),
                    Status = VersionStatus.Published, CreatedAt = at, PublishedAt = at,
                };
                db.Versions.Add(v);
                if (version != d.Version || imagesDir is null) continue;
                int position = 0;
                foreach (string shot in d.Shots)
                {
                    string path = Path.Combine(imagesDir, shot);
                    if (!File.Exists(path)) continue;
                    byte[] bytes = await File.ReadAllBytesAsync(path);
                    if (ReleaseMedia.Inspect(bytes) is not { } image) continue;
                    db.Media.Add(new ItemMedia
                    {
                        Id = Guid.NewGuid(), ItemId = d.Id, VersionId = v.Id, Role = MediaRoles.Screenshot, Position = position++,
                        Caption = Captions.GetValueOrDefault(shot), ContentType = image.ContentType,
                        Width = image.Width, Height = image.Height, Bytes = bytes, CreatedAt = at,
                    });
                }
            }
            for (int k = 0; k < d.Ratings.Length; k++)
            {
                (string name, string text) = Voices[(k + n) % Voices.Length];
                DateTime at = item.UpdatedAt.AddDays(k + 1);
                var review = new Review
                {
                    Id = Guid.NewGuid(), ItemId = d.Id, UserId = $"demo-user-{k}", UserName = name, Rating = d.Ratings[k], Text = text,
                    MajorVersion = PackageChecks.Major(d.Version), CreatedAt = at, UpdatedAt = at,
                };
                if (k == 2) { review.Reply = "Merci ! C'est prévu pour la prochaine version."; review.ReplyAt = at.AddDays(1); }
                db.Reviews.Add(review);
                item.RatingSum += d.Ratings[k];
                item.RatingCount++;
            }
        }
        await db.SaveChangesAsync();
    }
}
