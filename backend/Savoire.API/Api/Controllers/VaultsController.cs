// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// Routes : /api/v1/users/{userId}/vaults et /api/v1/vaults/{vaultId}

using MediatR;
using Microsoft.AspNetCore.Mvc;
using Savoire.Application.Common;
using Savoire.Application.Vaults.AddVaultMember;
using Savoire.Application.Vaults.CreateVault;
using Savoire.Application.Vaults.DeleteVault;
using Savoire.Application.Vaults.ListVaults;
using Savoire.Application.Vaults.RemoveVaultMember;
using Savoire.Application.Vaults.RenameVault;

namespace Savoire.Server.Controllers;

public class VaultsController(IMediator mediator) : AppControllerBase(mediator)
{
    // GET /api/v1/users/{userId}/vaults
    [HttpGet("api/v1/users/{userId}/vaults")]
    public async Task<IActionResult> List(string userId, CancellationToken ct)
        => Ok(await Mediator.Send(new ListVaultsQuery(userId), ct));

    // POST /api/v1/users/{userId}/vaults
    [HttpPost("api/v1/users/{userId}/vaults")]
    public async Task<IActionResult> Create(
        string userId, [FromBody] CreateVaultRequest req, CancellationToken ct)
    {
        VaultSummaryDto dto = await Mediator.Send(new CreateVaultCommand(userId, req.Name, req.IsManaged), ct);
        return StatusCode(201, dto);
    }

    // PATCH /api/v1/vaults/{vaultId}
    [HttpPatch("api/v1/vaults/{vaultId}")]
    public async Task<IActionResult> Rename(
        string vaultId, [FromBody] PatchVaultRequest req, CancellationToken ct)
        => Ok(await Mediator.Send(new RenameVaultCommand(GetCallerId(), vaultId, req.Name), ct));

    // DELETE /api/v1/vaults/{vaultId}
    [HttpDelete("api/v1/vaults/{vaultId}")]
    public async Task<IActionResult> Delete(string vaultId, CancellationToken ct)
    {
        await Mediator.Send(new DeleteVaultCommand(GetCallerId(), vaultId), ct);
        return NoContent();
    }

    // POST /api/v1/vaults/{vaultId}/members
    [HttpPost("api/v1/vaults/{vaultId}/members")]
    public async Task<IActionResult> AddMember(
        string vaultId, [FromBody] AddMemberRequest req, CancellationToken ct)
    {
        await Mediator.Send(new AddVaultMemberCommand(GetCallerId(), vaultId, req.UserId, req.Role), ct);
        return Ok(new { message = $"Member '{req.UserId}' added with role '{req.Role}'." });
    }

    // DELETE /api/v1/vaults/{vaultId}/members/{memberId}
    [HttpDelete("api/v1/vaults/{vaultId}/members/{memberId}")]
    public async Task<IActionResult> RemoveMember(
        string vaultId, string memberId, CancellationToken ct)
    {
        await Mediator.Send(new RemoveVaultMemberCommand(GetCallerId(), vaultId, memberId), ct);
        return NoContent();
    }
}
