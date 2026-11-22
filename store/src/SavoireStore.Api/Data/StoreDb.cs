// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Les donnees du store : ce qu'on y trouve (plugins, modeles de notes,
// modules, paquets de notes), leurs versions (paquets signes) et les avis.
using Microsoft.EntityFrameworkCore;

namespace SavoireStore.Data;

public static class ItemKinds
{
    public const string Plugin = "plugin";
    public const string Template = "template";
    public const string Module = "module";
    /// <summary>Une ou plusieurs notes (notes.zip), ajoutees au vault telles quelles.</summary>
    public const string Notes = "notes";
    /// <summary>Un modele d'agent IA (agent.json : consignes, droits, budget), sans code (ADR-033 de Savoire).</summary>
    public const string Agent = "agent";
    public static readonly string[] All = [Plugin, Template, Module, Notes, Agent];
}

public static class ItemStatus
{
    /// <summary>Premiere version en attente de relecture : pas encore au catalogue.</summary>
    public const string Pending = "pending";
    public const string Listed = "listed";
    public const string Rejected = "rejected";
    /// <summary>Retire par un administrateur (ou son editeur).</summary>
    public const string Removed = "removed";
}

public static class VersionStatus
{
    public const string Pending = "pending";
    public const string Published = "published";
    public const string Rejected = "rejected";
}

/// <summary>Un plugin, un modele de note ou un module.</summary>
public class Item
{
    /// <summary>L'id du manifeste (ex. « plugin-kanban »), unique dans le store.</summary>
    public string Id { get; set; } = null!;
    public string Kind { get; set; } = ItemKinds.Plugin;
    public string Name { get; set; } = null!;
    public string Summary { get; set; } = "";
    public string Description { get; set; } = "";
    public string Author { get; set; } = "";
    /// <summary>Le compte Savoire de l'editeur (sujet Zitadel).</summary>
    public string PublisherId { get; set; } = null!;
    /// <summary>Depot GitHub « proprietaire/nom », d'ou viennent les versions.</summary>
    public string Repo { get; set; } = null!;
    public string? License { get; set; }
    public string? Homepage { get; set; }
    public List<string> Categories { get; set; } = [];
    public string Status { get; set; } = ItemStatus.Pending;
    public string? LatestVersion { get; set; }
    /// <summary>Prix en centimes ; null : gratuit. Prevu dans le modele, l'achat viendra plus tard.</summary>
    public int? PriceCents { get; set; }
    public string? Currency { get; set; }
    public long Downloads { get; set; }
    public int RatingSum { get; set; }
    public int RatingCount { get; set; }
    public DateTime CreatedAt { get; set; }
    public DateTime UpdatedAt { get; set; }
}

/// <summary>Une version publiee depuis une release GitHub, avec son paquet signe.</summary>
public class ItemVersion
{
    public Guid Id { get; set; }
    public string ItemId { get; set; } = null!;
    public string Version { get; set; } = null!;
    public string? MinAppVersion { get; set; }
    /// <summary>manifest.json tel que publie.</summary>
    public string Manifest { get; set; } = null!;
    /// <summary>Le paquet (JSON : id, version, manifest, fichiers), tel qu'il est signe et servi.</summary>
    public byte[] Package { get; set; } = null!;
    public string Sha256 { get; set; } = null!;
    /// <summary>Signature ECDSA P-256 du paquet (base64, format IEEE P1363) ; posee a la publication.</summary>
    public string? Signature { get; set; }
    public List<string> Permissions { get; set; } = [];
    /// <summary>Resultat des controles automatiques (JSON : [{ level, message }]).</summary>
    public string Checks { get; set; } = "[]";
    public string Status { get; set; } = VersionStatus.Pending;
    public string? ReviewNote { get; set; }
    public string? ReleaseUrl { get; set; }
    public DateTime CreatedAt { get; set; }
    public DateTime? PublishedAt { get; set; }
}

/// <summary>Un avis : une note de 1 a 5 et un texte, un par compte et par version majeure.</summary>
public class Review
{
    public Guid Id { get; set; }
    public string ItemId { get; set; } = null!;
    public string UserId { get; set; } = null!;
    public string UserName { get; set; } = null!;
    public int Rating { get; set; }
    public string Text { get; set; } = "";
    public int MajorVersion { get; set; }
    public string? Reply { get; set; }
    public DateTime? ReplyAt { get; set; }
    public DateTime CreatedAt { get; set; }
    public DateTime UpdatedAt { get; set; }
}

public class StoreDb(DbContextOptions<StoreDb> options) : DbContext(options)
{
    public DbSet<Item> Items => Set<Item>();
    public DbSet<ItemVersion> Versions => Set<ItemVersion>();
    public DbSet<Review> Reviews => Set<Review>();

    protected override void OnModelCreating(ModelBuilder b)
    {
        b.Entity<Item>(e =>
        {
            e.ToTable("items");
            e.HasKey(x => x.Id);
            e.Property(x => x.Id).HasMaxLength(64);
            e.Property(x => x.Kind).HasMaxLength(16);
            e.Property(x => x.Name).HasMaxLength(100);
            e.Property(x => x.Summary).HasMaxLength(300);
            e.Property(x => x.Author).HasMaxLength(100);
            e.Property(x => x.Repo).HasMaxLength(200);
            e.Property(x => x.Status).HasMaxLength(16);
            e.Property(x => x.LatestVersion).HasMaxLength(32);
            e.Property(x => x.Currency).HasMaxLength(3);
            e.HasIndex(x => x.Repo).IsUnique();
            e.HasIndex(x => x.Status);
            e.HasIndex(x => x.PublisherId);
        });
        b.Entity<ItemVersion>(e =>
        {
            e.ToTable("item_versions");
            e.HasKey(x => x.Id);
            e.Property(x => x.Version).HasMaxLength(32);
            e.Property(x => x.Status).HasMaxLength(16);
            e.Property(x => x.Sha256).HasMaxLength(64);
            e.Property(x => x.Manifest).HasColumnType("jsonb");
            e.Property(x => x.Checks).HasColumnType("jsonb");
            e.HasIndex(x => new { x.ItemId, x.Version }).IsUnique();
            e.HasOne<Item>().WithMany().HasForeignKey(x => x.ItemId).OnDelete(DeleteBehavior.Cascade);
        });
        b.Entity<Review>(e =>
        {
            e.ToTable("reviews");
            e.HasKey(x => x.Id);
            e.Property(x => x.UserName).HasMaxLength(100);
            e.Property(x => x.Text).HasMaxLength(4000);
            e.Property(x => x.Reply).HasMaxLength(4000);
            e.HasIndex(x => new { x.ItemId, x.UserId, x.MajorVersion }).IsUnique();
            e.HasOne<Item>().WithMany().HasForeignKey(x => x.ItemId).OnDelete(DeleteBehavior.Cascade);
        });
    }
}
