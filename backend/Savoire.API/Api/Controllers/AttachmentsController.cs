// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// Attachments controller — upload / download / delete.
// GET is [AllowAnonymous]: browsers load <img src="..."> without sending the JWT Bearer token.

using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Savoire.Application.Abstractions;
using Savoire.Server.Models.Dto;

namespace Savoire.Server.Controllers;

[ApiController]
[Authorize]
[Route("api/v1/vaults/{vaultId}/attachments")]
public class AttachmentsController(IContentStore contentStore) : ControllerBase
{
    private static readonly HashSet<string> AllowedExtensions =
        [".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".avif"];

    private const long MaxFileSize = 20 * 1024 * 1024; // 20 MB

    // POST /api/v1/vaults/{vaultId}/attachments
    [HttpPost]
    public async Task<ActionResult<AttachmentDto>> Upload(
        string vaultId,
        IFormFile file,
        CancellationToken ct)
    {
        if (file.Length == 0)                         return BadRequest("Empty file.");
        if (file.Length > MaxFileSize)                return BadRequest("File too large (max 20 MB).");
        string ext = Path.GetExtension(file.FileName).ToLowerInvariant();
        if (!AllowedExtensions.Contains(ext))         return BadRequest($"Extension not allowed: {ext}");

        await using Stream stream = file.OpenReadStream();
        string storagePath = await contentStore.WriteAttachmentAsync(vaultId, file.FileName, stream, ct);

        return Ok(new AttachmentDto(
            FileName:    file.FileName,
            Path:        storagePath,
            Size:        file.Length,
            ContentType: file.ContentType));
    }

    // GET /api/v1/vaults/{vaultId}/attachments/{*path}
    [HttpGet("{*path}")]
    [AllowAnonymous] // Browsers cannot send JWT tokens for <img> tags
    public async Task<IActionResult> Download(string vaultId, string path, CancellationToken ct)
    {
        Stream? stream = await contentStore.ReadAttachmentAsync(vaultId, path, ct);
        if (stream is null) return NotFound();
        return File(stream, GetContentType(Path.GetExtension(path)));
    }

    // DELETE /api/v1/vaults/{vaultId}/attachments/{*path}
    [HttpDelete("{*path}")]
    public async Task<IActionResult> Delete(string vaultId, string path, CancellationToken ct)
    {
        await contentStore.DeleteAttachmentAsync(vaultId, path, ct);
        return NoContent();
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
}
