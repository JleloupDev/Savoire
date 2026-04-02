// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// SharingController — endpoints ACL + liens de partage.
// Routes :
//   GET    /api/v1/vaults/{vaultId}/sharing
//   POST   /api/v1/vaults/{vaultId}/sharing/permissions
//   DELETE /api/v1/vaults/{vaultId}/sharing/permissions/{targetUserId}
//   POST   /api/v1/vaults/{vaultId}/sharing/links
//   DELETE /api/v1/sharing/links/{linkId}
//   GET    /api/v1/share/{token}/access          [AllowAnonymous]
//   GET    /api/v1/documents/{docId}/sharing
//   POST   /api/v1/documents/{docId}/sharing/permissions
//   DELETE /api/v1/documents/{docId}/sharing/permissions/{targetUserId}
//   POST   /api/v1/documents/{docId}/sharing/links

using MediatR;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Savoire.Application.Common;
using Savoire.Application.Sharing.AccessShareLink;
using Savoire.Application.Sharing.CreateShareLink;
using Savoire.Application.Sharing.GetResourceSharing;
using Savoire.Application.Sharing.GrantPermission;
using Savoire.Application.Sharing.RevokePermission;
using Savoire.Application.Sharing.RevokeShareLink;

namespace Savoire.Server.Controllers;

public class SharingController(IMediator mediator) : AppControllerBase(mediator)
{
    // ── Vault-level sharing ───────────────────────────────────────────────────

    // GET /api/v1/vaults/{vaultId}/sharing
    [HttpGet("api/v1/vaults/{vaultId}/sharing")]
    public async Task<IActionResult> GetVaultSharing(string vaultId, CancellationToken ct)
        => Ok(await Mediator.Send(new GetResourceSharingQuery(GetCallerId(), "vault", vaultId), ct));

    // POST /api/v1/vaults/{vaultId}/sharing/permissions
    [HttpPost("api/v1/vaults/{vaultId}/sharing/permissions")]
    public async Task<IActionResult> GrantVaultPermission(
        string vaultId, [FromBody] GrantPermissionRequest req, CancellationToken ct)
    {
        ResourcePermissionDto dto = await Mediator.Send(
            new GrantPermissionCommand(GetCallerId(), "vault", vaultId, req.SubjectId, req.Permission, req.ExpiresAt), ct);
        return Ok(dto);
    }

    // DELETE /api/v1/vaults/{vaultId}/sharing/permissions/{targetUserId}
    [HttpDelete("api/v1/vaults/{vaultId}/sharing/permissions/{targetUserId}")]
    public async Task<IActionResult> RevokeVaultPermission(
        string vaultId, string targetUserId, CancellationToken ct)
    {
        await Mediator.Send(new RevokePermissionCommand(GetCallerId(), "vault", vaultId, targetUserId), ct);
        return NoContent();
    }

    // POST /api/v1/vaults/{vaultId}/sharing/links
    [HttpPost("api/v1/vaults/{vaultId}/sharing/links")]
    public async Task<IActionResult> CreateVaultShareLink(
        string vaultId, [FromBody] CreateShareLinkRequest req, CancellationToken ct)
    {
        ShareLinkDto dto = await Mediator.Send(
            new CreateShareLinkCommand(GetCallerId(), "vault", vaultId, req.Permission, req.ExpiresAt), ct);
        return Ok(dto);
    }

    // ── Document-level sharing ────────────────────────────────────────────────

    // GET /api/v1/documents/{docId}/sharing
    [HttpGet("api/v1/documents/{docId}/sharing")]
    public async Task<IActionResult> GetDocumentSharing(string docId, CancellationToken ct)
        => Ok(await Mediator.Send(new GetResourceSharingQuery(GetCallerId(), "document", docId), ct));

    // POST /api/v1/documents/{docId}/sharing/permissions
    [HttpPost("api/v1/documents/{docId}/sharing/permissions")]
    public async Task<IActionResult> GrantDocumentPermission(
        string docId, [FromBody] GrantPermissionRequest req, CancellationToken ct)
    {
        ResourcePermissionDto dto = await Mediator.Send(
            new GrantPermissionCommand(GetCallerId(), "document", docId, req.SubjectId, req.Permission, req.ExpiresAt), ct);
        return Ok(dto);
    }

    // DELETE /api/v1/documents/{docId}/sharing/permissions/{targetUserId}
    [HttpDelete("api/v1/documents/{docId}/sharing/permissions/{targetUserId}")]
    public async Task<IActionResult> RevokeDocumentPermission(
        string docId, string targetUserId, CancellationToken ct)
    {
        await Mediator.Send(new RevokePermissionCommand(GetCallerId(), "document", docId, targetUserId), ct);
        return NoContent();
    }

    // POST /api/v1/documents/{docId}/sharing/links
    [HttpPost("api/v1/documents/{docId}/sharing/links")]
    public async Task<IActionResult> CreateDocumentShareLink(
        string docId, [FromBody] CreateShareLinkRequest req, CancellationToken ct)
    {
        ShareLinkDto dto = await Mediator.Send(
            new CreateShareLinkCommand(GetCallerId(), "document", docId, req.Permission, req.ExpiresAt), ct);
        return Ok(dto);
    }

    // ── Shared (vault + document) ─────────────────────────────────────────────

    // DELETE /api/v1/sharing/links/{linkId}
    [HttpDelete("api/v1/sharing/links/{linkId}")]
    public async Task<IActionResult> RevokeShareLink(string linkId, CancellationToken ct)
    {
        await Mediator.Send(new RevokeShareLinkCommand(GetCallerId(), linkId), ct);
        return NoContent();
    }

    // GET /api/v1/share/{token}/access  — exchanges a share link token for a scoped JWT
    [AllowAnonymous]
    [HttpGet("api/v1/share/{token}/access")]
    public async Task<IActionResult> AccessShareLink(string token, CancellationToken ct)
        => Ok(await Mediator.Send(new AccessShareLinkQuery(token), ct));
}
