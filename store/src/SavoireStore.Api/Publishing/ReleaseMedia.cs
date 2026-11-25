// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Les images de presentation d'une version : une icone et des captures
// d'ecran, pieces jointes de la release, nommees dans manifest.json :
//
//   "icon": "icon.png",
//   "screenshots": ["capture-1.png", { "file": "capture-2.png", "caption": "Le tableau" }]
//
// PNG, JPEG ou WebP seulement (pas de SVG : il porte du script). Le format
// est lu dans les octets, jamais dans le nom. Hors du paquet signe.
using System.Buffers.Binary;
using System.Text.Json.Nodes;

namespace SavoireStore.Publishing;

public static class ReleaseMedia
{
    public const int MaxScreenshots = 8;
    public const long MaxIconBytes = 512 * 1024;
    public const long MaxScreenshotBytes = 3 * 1024 * 1024;
    public const int MaxCaption = 200;

    public sealed record Ref(string Role, string File, string? Caption, int Position);

    public sealed record Image(string ContentType, int Width, int Height);

    /// <summary>Les images nommees par le manifeste, et les erreurs de forme.</summary>
    public static List<Ref> Refs(JsonObject manifest, List<Check> checks)
    {
        var refs = new List<Ref>();
        void Err(string m) => checks.Add(new Check(Check.Error, m));
        if (manifest["icon"] is JsonNode iconNode)
        {
            if (iconNode is JsonValue v && v.TryGetValue(out string? icon) && ValidName(icon)) refs.Add(new Ref(Data.MediaRoles.Icon, icon, null, 0));
            else Err("manifest.json : « icon » est le nom d'une piece jointe de la release (ex. icon.png).");
        }
        if (manifest["screenshots"] is JsonNode shotsNode)
        {
            if (shotsNode is not JsonArray shots) { Err("manifest.json : « screenshots » est une liste."); return refs; }
            if (shots.Count > MaxScreenshots) Err($"manifest.json : {MaxScreenshots} captures d'ecran au plus.");
            int position = 0;
            foreach (JsonNode? s in shots.Take(MaxScreenshots))
            {
                string? file = null, caption = null;
                if (s is JsonValue sv && sv.TryGetValue(out string? f)) file = f;
                else if (s is JsonObject so)
                {
                    file = PackageChecks.Str(so, "file");
                    caption = PackageChecks.Str(so, "caption");
                }
                if (file is null || !ValidName(file)) { Err("manifest.json : chaque capture est un nom de piece jointe, ou { file, caption }."); continue; }
                if (caption is { Length: > MaxCaption }) Err($"manifest.json : legende de {MaxCaption} caracteres au plus ({file}).");
                refs.Add(new Ref(Data.MediaRoles.Screenshot, file, caption, position++));
            }
        }
        return refs;
    }

    public static long MaxBytes(string role) => role == Data.MediaRoles.Icon ? MaxIconBytes : MaxScreenshotBytes;

    private static bool ValidName(string? name) =>
        name is { Length: > 0 and <= 100 } && !name.Contains('/') && !name.Contains('\\') && !name.StartsWith('.');

    /// <summary>Le format et la taille d'une image, lus dans ses octets ; null si ce n'en est pas une admise.</summary>
    public static Image? Inspect(ReadOnlySpan<byte> b)
    {
        (string Type, int W, int H)? r = Png(b) ?? Jpeg(b) ?? WebP(b);
        if (r is not { } x || x.W is < 16 or > 8192 || x.H is < 16 or > 8192) return null;
        return new Image(x.Type, x.W, x.H);
    }

    private static (string, int, int)? Png(ReadOnlySpan<byte> b)
    {
        ReadOnlySpan<byte> sig = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
        if (b.Length < 24 || !b[..8].SequenceEqual(sig) || !b.Slice(12, 4).SequenceEqual("IHDR"u8)) return null;
        return ("image/png", (int)BinaryPrimitives.ReadUInt32BigEndian(b.Slice(16, 4)), (int)BinaryPrimitives.ReadUInt32BigEndian(b.Slice(20, 4)));
    }

    private static (string, int, int)? Jpeg(ReadOnlySpan<byte> b)
    {
        if (b.Length < 4 || b[0] != 0xFF || b[1] != 0xD8) return null;
        int i = 2;
        while (i + 9 < b.Length)
        {
            if (b[i] != 0xFF) return null;
            byte marker = b[i + 1];
            if (marker == 0xFF) { i++; continue; }
            int length = BinaryPrimitives.ReadUInt16BigEndian(b.Slice(i + 2, 2));
            // SOF0 a SOF15, sauf DHT (C4), JPG (C8) et DAC (CC) : la taille de l'image.
            if (marker is >= 0xC0 and <= 0xCF && marker is not (0xC4 or 0xC8 or 0xCC))
                return ("image/jpeg", BinaryPrimitives.ReadUInt16BigEndian(b.Slice(i + 7, 2)), BinaryPrimitives.ReadUInt16BigEndian(b.Slice(i + 5, 2)));
            if (length < 2) return null;
            i += 2 + length;
        }
        return null;
    }

    private static (string, int, int)? WebP(ReadOnlySpan<byte> b)
    {
        if (b.Length < 30 || !b[..4].SequenceEqual("RIFF"u8) || !b.Slice(8, 4).SequenceEqual("WEBP"u8)) return null;
        ReadOnlySpan<byte> chunk = b.Slice(12, 4);
        if (chunk.SequenceEqual("VP8 "u8))
            return ("image/webp", BinaryPrimitives.ReadUInt16LittleEndian(b.Slice(26, 2)) & 0x3FFF, BinaryPrimitives.ReadUInt16LittleEndian(b.Slice(28, 2)) & 0x3FFF);
        if (chunk.SequenceEqual("VP8L"u8))
        {
            uint bits = BinaryPrimitives.ReadUInt32LittleEndian(b.Slice(21, 4));
            return ("image/webp", (int)(bits & 0x3FFF) + 1, (int)((bits >> 14) & 0x3FFF) + 1);
        }
        if (chunk.SequenceEqual("VP8X"u8))
        {
            int w = 1 + (b[24] | b[25] << 8 | b[26] << 16);
            int h = 1 + (b[27] | b[28] << 8 | b[29] << 16);
            return ("image/webp", w, h);
        }
        return null;
    }
}
