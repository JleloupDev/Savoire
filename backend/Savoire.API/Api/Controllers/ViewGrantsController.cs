// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
using System.IdentityModel.Tokens.Jwt;
using System.Security.Claims;
using MediatR;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Authentication.JwtBearer;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging;
using Savoire.Application.Common;
using Savoire.Application.ViewGrants.CreateViewGrant;
using Savoire.Application.ViewGrants.RedeemViewGrant;

namespace Savoire.Server.Controllers;

[ApiController]
public class ViewGrantsController(IMediator mediator, ILogger<ViewGrantsController> logger) : ControllerBase
{
    // POST /api/v1/view/internal-grants
    // Internal app flow only (authenticated vault user).
    [Authorize]
    [HttpPost("api/v1/view/internal-grants")]
    public async Task<IActionResult> CreateInternal([FromBody] CreateViewGrantRequest req, CancellationToken ct)
    {
        string traceId = HttpContext.TraceIdentifier;
        string? callerId = User.FindFirst(JwtRegisteredClaimNames.Sub)?.Value
            ?? User.FindFirst(ClaimTypes.NameIdentifier)?.Value;
        logger.LogInformation(
            "[{TraceId}] view/internal-grants request caller={Caller} vault={VaultId} doc={DocId} path={Path} permission={Permission}",
            traceId, callerId, req.VaultId, req.DocId, req.Path, req.Permission);
        if (string.IsNullOrWhiteSpace(callerId))
        {
            logger.LogWarning("[{TraceId}] view/internal-grants forbidden: missing caller id", traceId);
            return Forbid();
        }

        var dto = await mediator.Send(new CreateViewGrantCommand(
            callerId,
            null, // Internal mode never uses share token.
            req.VaultId,
            req.DocId,
            req.Path,
            req.Permission
        ), ct);
        logger.LogInformation("[{TraceId}] view/internal-grants granted doc={DocId} permission={Permission}", traceId, dto.DocId, dto.Permission);
        return Ok(dto);
    }

    // POST /api/v1/view/grants
    // Auth modes:
    // - Bearer app token (user)
    // - Bearer scoped share token (sub=share:...)
    // - Anonymous with shareToken in body
    [AllowAnonymous]
    [HttpPost("api/v1/view/grants")]
    public async Task<IActionResult> Create([FromBody] CreateViewGrantRequest req, CancellationToken ct)
    {
        string traceId = HttpContext.TraceIdentifier;
        string? callerId = User.FindFirst(JwtRegisteredClaimNames.Sub)?.Value
            ?? User.FindFirst(ClaimTypes.NameIdentifier)?.Value;
        logger.LogInformation(
            "[{TraceId}] view/grants request caller={Caller} hasShareToken={HasShareToken} vault={VaultId} doc={DocId} path={Path} permission={Permission}",
            traceId, callerId, !string.IsNullOrWhiteSpace(req.ShareToken), req.VaultId, req.DocId, req.Path, req.Permission);

        if (string.IsNullOrWhiteSpace(callerId))
        {
            AuthenticateResult auth = await HttpContext.AuthenticateAsync(JwtBearerDefaults.AuthenticationScheme);
            if (auth.Succeeded)
            {
                callerId = auth.Principal?.FindFirst(JwtRegisteredClaimNames.Sub)?.Value
                    ?? auth.Principal?.FindFirst(ClaimTypes.NameIdentifier)?.Value;
            }
        }
        logger.LogInformation("[{TraceId}] view/grants resolved caller={Caller}", traceId, callerId);

        var dto = await mediator.Send(new CreateViewGrantCommand(
            callerId,
            req.ShareToken,
            req.VaultId,
            req.DocId,
            req.Path,
            req.Permission
        ), ct);
        logger.LogInformation("[{TraceId}] view/grants granted doc={DocId} permission={Permission}", traceId, dto.DocId, dto.Permission);
        return Ok(dto);
    }

    // POST /api/v1/view/grants/redeem
    [AllowAnonymous]
    [HttpPost("api/v1/view/grants/redeem")]
    public async Task<IActionResult> Redeem([FromBody] RedeemViewGrantRequest req, CancellationToken ct)
    {
        string traceId = HttpContext.TraceIdentifier;
        logger.LogInformation(
            "[{TraceId}] view/grants/redeem request tokenLen={TokenLen} tokenPrefix={TokenPrefix}",
            traceId,
            req.GrantToken?.Length ?? 0,
            MaskPrefix(req.GrantToken));
        var dto = await mediator.Send(new RedeemViewGrantCommand(req.GrantToken), ct);
        logger.LogInformation("[{TraceId}] view/grants/redeem success doc={DocId} permission={Permission}", traceId, dto.DocId, dto.Permission);
        return Ok(dto);
    }

    private static string MaskPrefix(string? token)
    {
        if (string.IsNullOrWhiteSpace(token)) return "<empty>";
        int len = Math.Min(16, token.Length);
        return token[..len];
    }
}
