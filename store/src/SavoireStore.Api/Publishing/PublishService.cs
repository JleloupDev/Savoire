// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Publier une version, et la relire.
//
//  1. L'editeur donne son depot GitHub ; le store lit la derniere release.
//  2. Controles automatiques (PackageChecks). Une erreur : refus immediat.
//  3. Premiere version d'un element, ou un avertissement : relecture humaine
//     (file d'attente des administrateurs). Sinon : publiee tout de suite.
//  4. Publiee = paquet signe ; la derniere version du catalogue avance.
//
// Un element appartient a son premier editeur : une autre personne ne peut
// pas publier sous le meme id, ni depuis un autre depot.
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.EntityFrameworkCore;
using SavoireStore.Data;
using SavoireStore.Signing;

namespace SavoireStore.Publishing;

public sealed record PublishResult(string ItemId, string Version, string Status, IReadOnlyList<Check> Checks);

public sealed class PublishService(StoreDb db, GitHubReleases github, PackageSigner signer)
{
    public async Task<PublishResult> SubmitAsync(string publisherId, string publisherName, string repo, CancellationToken ct)
    {
        repo = repo.Trim().Trim('/');
        if (repo.StartsWith("https://github.com/", StringComparison.OrdinalIgnoreCase)) repo = repo["https://github.com/".Length..];
        Release release = await github.LatestAsync(repo, ct);

        ReleaseAsset manifestAsset = release.Assets.FirstOrDefault(a => a.Name == "manifest.json")
            ?? throw new PublishException(422, "no_manifest", "La release n'a pas de piece jointe manifest.json.");
        JsonObject manifest;
        try
        {
            manifest = JsonNode.Parse(await github.DownloadTextAsync(manifestAsset, ct)) as JsonObject
                ?? throw new PublishException(422, "invalid_manifest", "manifest.json n'est pas un objet JSON.");
        }
        catch (JsonException)
        {
            throw new PublishException(422, "invalid_manifest", "manifest.json n'est pas du JSON valide.");
        }

        string kind = PackageChecks.Str(manifest, "kind") ?? ItemKinds.Plugin;
        if (!ItemKinds.All.Contains(kind)) throw new PublishException(422, "invalid_kind", $"Sorte inconnue : {kind} (plugin, template, module, notes ou agent).");
        (string[] required, string[] optional) = PackageChecks.FilesOf(kind);
        var files = new SortedDictionary<string, string>(StringComparer.Ordinal);
        foreach (ReleaseAsset a in release.Assets.Where(a => required.Contains(a.Name) || optional.Contains(a.Name)))
            files[a.Name] = await github.DownloadTextAsync(a, ct);
        bool hasLicense = release.Assets.Any(a => a.Name.StartsWith("LICENSE", StringComparison.OrdinalIgnoreCase));

        var archiveErrors = new List<string>();
        if (kind == ItemKinds.Notes && release.Assets.FirstOrDefault(a => a.Name == NotesArchive.AssetName) is { } zip)
        {
            byte[] bytes = await github.DownloadBytesAsync(zip, NotesArchive.MaxArchiveBytes, ct);
            foreach ((string path, string text) in NotesArchive.Read(bytes, archiveErrors)) files[path] = text;
        }

        List<Check> checks = PackageChecks.Run(manifest, kind, release.Tag, files, hasLicense);
        checks.AddRange(archiveErrors.Select(e => new Check(Check.Error, e)));
        List<(ReleaseMedia.Ref Ref, ReleaseMedia.Image Image, byte[] Bytes)> media = await DownloadMediaAsync(manifest, release, checks, ct);
        string? id = PackageChecks.Str(manifest, "id");
        string? version = PackageChecks.Str(manifest, "version");
        if (checks.Any(c => c.Level == Check.Error) || id is null || version is null)
            return new PublishResult(id ?? "", version ?? release.Tag, VersionStatus.Rejected, checks);

        DateTime now = DateTime.UtcNow;
        Item? item = await db.Items.FirstOrDefaultAsync(i => i.Id == id, ct);
        if (item is null)
        {
            if (await db.Items.AnyAsync(i => i.Repo == repo, ct))
                throw new PublishException(409, "repo_taken", "Ce depot publie deja un autre element.");
            item = new Item
            {
                Id = id, Kind = kind, PublisherId = publisherId, Repo = repo, Status = ItemStatus.Pending,
                Name = PackageChecks.Str(manifest, "name")!, CreatedAt = now,
            };
            db.Items.Add(item);
        }
        else
        {
            if (item.PublisherId != publisherId) throw new PublishException(403, "not_publisher", "Cet id appartient a un autre editeur.");
            if (!string.Equals(item.Repo, repo, StringComparison.OrdinalIgnoreCase))
                throw new PublishException(409, "other_repo", $"Cet element se publie depuis {item.Repo}.");
            if (item.Status == ItemStatus.Removed) throw new PublishException(403, "removed", "Cet element a ete retire du store.");
            if (item.Kind != kind) throw new PublishException(409, "kind_changed", "La sorte d'un element ne change pas.");
        }
        if (await db.Versions.AnyAsync(v => v.ItemId == id && v.Version == version, ct))
            throw new PublishException(409, "version_exists", $"La version {version} est deja envoyee.");

        byte[] package = BuildPackage(id, kind, version, manifest, files);
        var v = new ItemVersion
        {
            Id = Guid.NewGuid(), ItemId = id, Version = version, MinAppVersion = PackageChecks.Str(manifest, "minAppVersion"),
            Manifest = manifest.ToJsonString(), Package = package, Sha256 = PackageSigner.Sha256(package),
            Permissions = PackageChecks.StrList(manifest, "permissions"),
            Checks = JsonSerializer.Serialize(checks, JsonOptions), ReleaseUrl = release.HtmlUrl,
            Status = VersionStatus.Pending, CreatedAt = now,
        };
        db.Versions.Add(v);
        Guid? iconId = null;
        foreach ((ReleaseMedia.Ref r, ReleaseMedia.Image image, byte[] bytes) in media)
        {
            var m = new ItemMedia
            {
                Id = Guid.NewGuid(), ItemId = id, VersionId = v.Id, Role = r.Role, Position = r.Position, Caption = r.Caption,
                ContentType = image.ContentType, Width = image.Width, Height = image.Height, Bytes = bytes, CreatedAt = now,
            };
            if (r.Role == MediaRoles.Icon) iconId = m.Id;
            db.Media.Add(m);
        }
        if (item.Status == ItemStatus.Listed && checks.Count == 0) Publish(item, v, manifest, publisherName, now, iconId);
        else if (item.Status != ItemStatus.Listed)
        {
            // Pas encore au catalogue : ses textes suivent la derniere version envoyee.
            ApplyManifest(item, manifest, publisherName);
            item.IconId = iconId;
            item.Status = ItemStatus.Pending;
            item.UpdatedAt = now;
        }
        await db.SaveChangesAsync(ct);
        return new PublishResult(id, version, v.Status, checks);
    }

    /// <summary>Relecture : accepter une version en attente.</summary>
    public async Task ApproveAsync(Guid versionId, string? note, CancellationToken ct)
    {
        ItemVersion v = await db.Versions.FirstOrDefaultAsync(x => x.Id == versionId, ct)
            ?? throw new PublishException(404, "not_found", "Version introuvable.");
        if (v.Status != VersionStatus.Pending) throw new PublishException(409, "not_pending", "Cette version n'attend pas de relecture.");
        Item item = await db.Items.FirstAsync(i => i.Id == v.ItemId, ct);
        if (item.Status == ItemStatus.Removed) throw new PublishException(409, "removed", "Element retire du store.");
        v.ReviewNote = note;
        Guid? iconId = await db.Media.Where(m => m.VersionId == v.Id && m.Role == MediaRoles.Icon).Select(m => (Guid?)m.Id).FirstOrDefaultAsync(ct);
        Publish(item, v, JsonNode.Parse(v.Manifest)!.AsObject(), item.Author, DateTime.UtcNow, iconId);
        await db.SaveChangesAsync(ct);
    }

    /// <summary>Relecture : refuser une version (avec la raison, montree a l'editeur).</summary>
    public async Task RejectAsync(Guid versionId, string reason, CancellationToken ct)
    {
        ItemVersion v = await db.Versions.FirstOrDefaultAsync(x => x.Id == versionId, ct)
            ?? throw new PublishException(404, "not_found", "Version introuvable.");
        if (v.Status != VersionStatus.Pending) throw new PublishException(409, "not_pending", "Cette version n'attend pas de relecture.");
        v.Status = VersionStatus.Rejected;
        v.ReviewNote = reason;
        Item item = await db.Items.FirstAsync(i => i.Id == v.ItemId, ct);
        if (item.Status == ItemStatus.Pending
            && !await db.Versions.AnyAsync(x => x.ItemId == item.Id && x.Id != v.Id && x.Status != VersionStatus.Rejected, ct))
            item.Status = ItemStatus.Rejected;
        item.UpdatedAt = DateTime.UtcNow;
        await db.SaveChangesAsync(ct);
    }

    /// <summary>
    /// Icone et captures de la release, controlees : une image manquante, trop
    /// lourde ou d'un format non admis est une erreur (la version est refusee).
    /// </summary>
    private async Task<List<(ReleaseMedia.Ref, ReleaseMedia.Image, byte[])>> DownloadMediaAsync(JsonObject manifest, Release release, List<Check> checks, CancellationToken ct)
    {
        var result = new List<(ReleaseMedia.Ref, ReleaseMedia.Image, byte[])>();
        foreach (ReleaseMedia.Ref r in ReleaseMedia.Refs(manifest, checks))
        {
            ReleaseAsset? asset = release.Assets.FirstOrDefault(a => a.Name == r.File);
            if (asset is null) { checks.Add(new Check(Check.Error, $"Image manquante dans la release : {r.File}.")); continue; }
            long max = ReleaseMedia.MaxBytes(r.Role);
            if (asset.Size > max) { checks.Add(new Check(Check.Error, $"{r.File} depasse {max / 1024} Kio.")); continue; }
            byte[] bytes;
            try { bytes = await github.DownloadBytesAsync(asset, max, ct); }
            catch (PublishException ex) when (ex.Code == "asset_too_large") { checks.Add(new Check(Check.Error, $"{r.File} depasse {max / 1024} Kio.")); continue; }
            if (ReleaseMedia.Inspect(bytes) is not { } image)
            {
                checks.Add(new Check(Check.Error, $"{r.File} : image PNG, JPEG ou WebP attendue (16 a 8192 pixels de cote)."));
                continue;
            }
            result.Add((r, image, bytes));
        }
        return result;
    }

    private void Publish(Item item, ItemVersion v, JsonObject manifest, string publisherName, DateTime now, Guid? iconId)
    {
        v.Signature = signer.Sign(v.Package);
        v.Status = VersionStatus.Published;
        v.PublishedAt = now;
        if (item.LatestVersion is null || PackageChecks.CompareVersions(v.Version, item.LatestVersion) > 0)
        {
            item.LatestVersion = v.Version;
            ApplyManifest(item, manifest, publisherName);
            item.IconId = iconId;
        }
        item.Status = ItemStatus.Listed;
        item.UpdatedAt = now;
    }

    private static void ApplyManifest(Item item, JsonObject manifest, string publisherName)
    {
        item.Name = PackageChecks.Str(manifest, "name") ?? item.Name;
        item.Summary = PackageChecks.Str(manifest, "description") ?? "";
        item.Description = PackageChecks.Str(manifest, "longDescription") ?? item.Summary;
        item.Author = PackageChecks.Str(manifest, "author") ?? publisherName;
        item.License = PackageChecks.Str(manifest, "license");
        item.Homepage = PackageChecks.Str(manifest, "homepage");
        item.Categories = PackageChecks.StrList(manifest, "categories").Select(Categories.Slug).Where(c => c.Length > 0).Distinct().Take(5).ToList();
    }

    /// <summary>Le paquet tel qu'il est signe et servi : JSON, cles dans un ordre fixe.</summary>
    public static byte[] BuildPackage(string id, string kind, string version, JsonObject manifest, IReadOnlyDictionary<string, string> files)
    {
        var filesNode = new JsonObject();
        foreach ((string name, string text) in files.OrderBy(f => f.Key, StringComparer.Ordinal)) filesNode[name] = text;
        var package = new JsonObject
        {
            ["format"] = 1,
            ["id"] = id,
            ["kind"] = kind,
            ["version"] = version,
            ["manifest"] = manifest.DeepClone(),
            ["files"] = filesNode,
        };
        return JsonSerializer.SerializeToUtf8Bytes(package);
    }

    public static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);
}
