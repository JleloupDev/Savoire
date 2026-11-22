// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Un paquet de notes : la piece jointe notes.zip d'une release. Ses fichiers
// gardent leur chemin ; Savoire les ajoute au vault ouvert, a ces chemins,
// sans remplacer une note qui existe deja.
//
// Refus : chemin absolu ou qui remonte (« .. »), dossier cache (.obsidian,
// .trash...), extension hors liste, texte qui n'est pas de l'UTF-8, trop de
// fichiers, archive ou contenu trop gros.
using System.IO.Compression;
using System.Text;

namespace SavoireStore.Publishing;

public static class NotesArchive
{
    public const string AssetName = "notes.zip";
    /// <summary>Prefixe des notes dans les fichiers du paquet (« notes/Bible/Bible.md »).</summary>
    public const string Prefix = "notes/";
    public const int MaxFiles = 5000;
    public const long MaxArchiveBytes = 20 * 1024 * 1024;
    /// <summary>Texte decompresse, toutes notes comprises.</summary>
    public const long MaxContentBytes = 40 * 1024 * 1024;
    public const int MaxPathLength = 400;

    /// <summary>Fichiers texte qu'un vault Savoire ouvre.</summary>
    public static readonly string[] Extensions = [".md", ".txt", ".canvas", ".excalidraw", ".table", ".mm", ".board", ".base"];

    private static readonly UTF8Encoding StrictUtf8 = new(encoderShouldEmitUTF8Identifier: false, throwOnInvalidBytes: true);

    /// <summary>Les notes de l'archive, par chemin prefixe ; les erreurs vont dans `errors`.</summary>
    public static SortedDictionary<string, string> Read(byte[] zip, List<string> errors)
    {
        var notes = new SortedDictionary<string, string>(StringComparer.Ordinal);
        ZipArchive archive;
        try { archive = new ZipArchive(new MemoryStream(zip), ZipArchiveMode.Read); }
        catch (InvalidDataException) { errors.Add("notes.zip n'est pas une archive zip lisible."); return notes; }
        using (archive)
        {
            long total = 0;
            foreach (ZipArchiveEntry entry in archive.Entries)
            {
                if (entry.FullName.EndsWith('/')) continue; // dossier
                string path = entry.FullName.Replace('\\', '/');
                if (PathProblem(path) is { } problem) { errors.Add($"notes.zip : {problem} ({path})."); continue; }
                if (notes.Count >= MaxFiles) { errors.Add($"notes.zip : plus de {MaxFiles} fichiers."); break; }
                total += entry.Length;
                if (total > MaxContentBytes) { errors.Add($"notes.zip : plus de {MaxContentBytes / (1024 * 1024)} Mio une fois decompresse."); break; }
                using var buffer = new MemoryStream();
                using (Stream s = entry.Open()) s.CopyTo(buffer);
                try { notes[Prefix + path] = StrictUtf8.GetString(buffer.GetBuffer(), 0, (int)buffer.Length).TrimStart('﻿'); }
                catch (DecoderFallbackException) { errors.Add($"notes.zip : {path} n'est pas du texte UTF-8."); }
            }
        }
        if (notes.Count == 0 && errors.Count == 0) errors.Add("notes.zip ne contient aucune note.");
        return notes;
    }

    /// <summary>Ce qui ne va pas dans un chemin, ou null.</summary>
    public static string? PathProblem(string path)
    {
        if (path.Length == 0 || path.Length > MaxPathLength) return "chemin vide ou trop long";
        if (path.StartsWith('/') || path.Contains(':')) return "chemin absolu";
        string[] parts = path.Split('/');
        if (parts.Any(p => p.Length == 0 || p == "." || p == "..")) return "chemin invalide";
        if (parts.Any(p => p.StartsWith('.'))) return "fichier ou dossier cache";
        if (path.Any(c => char.IsControl(c) || "<>\"|?*".Contains(c))) return "caractere interdit dans le chemin";
        string ext = Path.GetExtension(path).ToLowerInvariant();
        if (!Extensions.Contains(ext)) return $"extension non prise en charge ({(ext.Length > 0 ? ext : "aucune")})";
        return null;
    }
}
