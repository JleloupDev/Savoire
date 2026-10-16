// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// Pieces jointes d'un vault : envoi, lecture, suppression.
//
// Toutes les routes exigent un compte connecte ET le droit sur le vault
// (VaultAccessBehavior, via MediatR) : lire = lecteur, ecrire = redacteur.
//
// DECISION : la lecture n'est plus anonyme. Une balise <img> ne sait pas
// envoyer le jeton Bearer ; le client lit donc l'image en fetch authentifie
// et l'affiche par une URL blob: (comme le profil pair a pair, qui n'a que des
// URL blob). Rien a signer, pas de cookie, pas de secret de plus. Effet de
// bord utile : un SVG n'est jamais ouvert directement sur notre origine.

using System.Text.RegularExpressions;
using MediatR;
using Microsoft.AspNetCore.Mvc;
using Savoire.Application.Attachments;
using Savoire.Server.Models.Dto;

namespace Savoire.Server.Controllers;

[Route("api/v1/vaults/{vaultId}/attachments")]
public partial class AttachmentsController(IMediator mediator) : AppControllerBase(mediator)
{
    private static readonly HashSet<string> AllowedExtensions =
        [".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".avif"];

    private const long MaxFileSize = 20 * 1024 * 1024; // 20 MB

    /// <summary>
    /// Chemin de stockage accepte : un identifiant (lettres, chiffres, tirets)
    /// et une extension facultative. Jamais de « / » ni de « .. » : le chemin
    /// finit dans un nom de fichier sur disque.
    /// </summary>
    [GeneratedRegex(@"^[A-Za-z0-9_-]{1,64}(\.[A-Za-z0-9]{1,8})?$")]
    private static partial Regex StoragePathRegex();

    [GeneratedRegex(@"^[A-Za-z0-9-]{1,64}$")]
    private static partial Regex FileIdRegex();

    // POST /api/v1/vaults/{vaultId}/attachments  (ancien : nom genere par le serveur)
    [HttpPost]
    public Task<ActionResult<AttachmentDto>> Upload(string vaultId, IFormFile file, CancellationToken ct)
        => Store(vaultId, null, file, ct);

    // POST /api/v1/vaults/{vaultId}/attachments/{fileId}  (rangee sous l'id du document)
    [HttpPost("{fileId}")]
    public Task<ActionResult<AttachmentDto>> UploadWithId(string vaultId, string fileId, IFormFile file, CancellationToken ct)
        => FileIdRegex().IsMatch(fileId)
            ? Store(vaultId, fileId, file, ct)
            : Task.FromResult<ActionResult<AttachmentDto>>(BadRequest("Invalid file id."));

    private async Task<ActionResult<AttachmentDto>> Store(string vaultId, string? fileId, IFormFile file, CancellationToken ct)
    {
        if (file.Length == 0)                         return BadRequest("Empty file.");
        if (file.Length > MaxFileSize)                return BadRequest("File too large (max 20 MB).");
        string ext = Path.GetExtension(file.FileName).ToLowerInvariant();
        if (!AllowedExtensions.Contains(ext))         return BadRequest($"Extension not allowed: {ext}");

        await using Stream stream = file.OpenReadStream();
        string storagePath = await Mediator.Send(
            new StoreAttachmentCommand(vaultId, fileId, file.FileName, stream, GetCallerId()), ct);

        return Ok(new AttachmentDto(
            FileName:    file.FileName,
            Path:        storagePath,
            Size:        file.Length,
            ContentType: file.ContentType));
    }

    // GET /api/v1/vaults/{vaultId}/attachments/{path}
    [HttpGet("{*path}")]
    public async Task<IActionResult> Download(string vaultId, string path, CancellationToken ct)
    {
        if (!StoragePathRegex().IsMatch(path)) return BadRequest("Invalid path.");
        Stream? stream = await Mediator.Send(new ReadAttachmentQuery(vaultId, path, GetCallerId()), ct);
        if (stream is null) return NotFound();

        // Un fichier range sous un identifiant n'a pas d'extension : son type
        // se lit dans ses premiers octets.
        string ext = Path.GetExtension(path);
        if (ext.Length > 0) return File(stream, GetContentType(ext));
        byte[] bytes = await ReadAllAsync(stream, ct);
        return File(bytes, SniffContentType(bytes));
    }

    // DELETE /api/v1/vaults/{vaultId}/attachments/{path}
    [HttpDelete("{*path}")]
    public async Task<IActionResult> Delete(string vaultId, string path, CancellationToken ct)
    {
        if (!StoragePathRegex().IsMatch(path)) return BadRequest("Invalid path.");
        await Mediator.Send(new DeleteAttachmentCommand(vaultId, path, GetCallerId()), ct);
        return NoContent();
    }

    private static async Task<byte[]> ReadAllAsync(Stream stream, CancellationToken ct)
    {
        await using (stream)
        {
            using var buffer = new MemoryStream();
            await stream.CopyToAsync(buffer, ct);
            return buffer.ToArray();
        }
    }

    private static string GetContentType(string ext) => ext.ToLowerInvariant() switch
    {
        ".png"        => "image/png",
        ".jpg"        => "image/jpeg",
        ".jpeg"       => "image/jpeg",
        ".gif"        => "image/gif",
        ".webp"       => "image/webp",
        ".svg"        => "image/svg+xml",
        ".avif"       => "image/avif",
        _             => "application/octet-stream",
    };

    /// <summary>Type d'une image d'apres sa signature (seuls les formats acceptes a l'envoi).</summary>
    private static string SniffContentType(byte[] b)
    {
        bool StartsWith(int offset, params byte[] sig) =>
            b.Length >= offset + sig.Length && b.AsSpan(offset, sig.Length).SequenceEqual(sig);

        if (StartsWith(0, 0x89, 0x50, 0x4E, 0x47)) return "image/png";
        if (StartsWith(0, 0xFF, 0xD8, 0xFF))       return "image/jpeg";
        if (StartsWith(0, 0x47, 0x49, 0x46, 0x38)) return "image/gif";
        if (StartsWith(0, 0x52, 0x49, 0x46, 0x46) && StartsWith(8, 0x57, 0x45, 0x42, 0x50)) return "image/webp";
        if (StartsWith(4, 0x66, 0x74, 0x79, 0x70, 0x61, 0x76, 0x69)) return "image/avif";
        string head = System.Text.Encoding.UTF8.GetString(b, 0, Math.Min(b.Length, 512)).TrimStart('﻿', ' ', '\t', '\r', '\n');
        if (head.StartsWith("<svg", StringComparison.OrdinalIgnoreCase) || head.StartsWith("<?xml", StringComparison.OrdinalIgnoreCase))
            return "image/svg+xml";
        return "application/octet-stream";
    }
}
