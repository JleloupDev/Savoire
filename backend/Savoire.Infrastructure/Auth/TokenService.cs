// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
using System.IdentityModel.Tokens.Jwt;
using System.Security.Claims;
using System.Text;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging;
using Microsoft.IdentityModel.Tokens;
using Savoire.Domain.Aggregates;
using Savoire.Domain.Entities;
using Savoire.Domain.Enums;
using Savoire.Domain.Exceptions;
using Savoire.Domain.Interfaces;

namespace Savoire.Infrastructure.Auth;

// Jetons signes par Savoire lui-meme : liens de partage et vues integrees.
// Les comptes, eux, se connectent chez le fournisseur d'identite (ADR-028).
public class TokenService(
    IConfiguration config,
    ILogger<TokenService> logger) : ITokenService
{
    public string GenerateShareLinkAccessToken(ShareLink link)
    {
        var jwtConfig = config.GetSection("Jwt");
        var key = new SymmetricSecurityKey(
            Encoding.UTF8.GetBytes(jwtConfig["Secret"]!));

        var expires = link.ExpiresAt?.ToUniversalTime()
            ?? DateTime.UtcNow.AddHours(8);

        var claims = new List<Claim>
        {
            new(JwtRegisteredClaimNames.Sub,  $"share:{link.Id}"),
            new(JwtRegisteredClaimNames.Jti,  Guid.NewGuid().ToString()),
            new("share_link_id",       link.Id),
            new("share_resource_type", link.ResourceType.ToApiString()),
            new("share_resource_id",   link.ResourceId),
            new("share_permission",    link.Permission.ToApiString()),
        };

        var token = new JwtSecurityToken(
            issuer:   jwtConfig["Issuer"]   ?? "vault-server",
            audience: jwtConfig["Audience"] ?? "vault-client",
            claims:   claims,
            expires:  expires,
            signingCredentials: new SigningCredentials(key, SecurityAlgorithms.HmacSha256)
        );

        return new JwtSecurityTokenHandler().WriteToken(token);
    }

    public string GenerateViewGrantToken(ViewGrantPayload payload)
    {
        var jwtConfig = config.GetSection("Jwt");
        var key = new SymmetricSecurityKey(
            Encoding.UTF8.GetBytes(jwtConfig["Secret"]!));

        var claims = new List<Claim>
        {
            new(JwtRegisteredClaimNames.Sub, "view-grant"),
            new(JwtRegisteredClaimNames.Jti, Guid.NewGuid().ToString()),
            new("view_vault_id", payload.VaultId),
            new("view_doc_id", payload.DocId),
            new("view_path", payload.Path),
            new("view_permission", payload.Permission),
        };
        if (!string.IsNullOrWhiteSpace(payload.UserId))
            claims.Add(new Claim("view_user_id", payload.UserId));

        var token = new JwtSecurityToken(
            issuer: jwtConfig["Issuer"] ?? "vault-server",
            audience: jwtConfig["Audience"] ?? "vault-client",
            claims: claims,
            expires: payload.ExpiresAtUtc,
            signingCredentials: new SigningCredentials(key, SecurityAlgorithms.HmacSha256)
        );

        return new JwtSecurityTokenHandler().WriteToken(token);
    }

    public ViewGrantPayload ReadViewGrantToken(string grantToken)
    {
        logger.LogInformation(
            "ReadViewGrantToken start tokenLen={TokenLen} tokenPrefix={TokenPrefix}",
            grantToken?.Length ?? 0,
            MaskPrefix(grantToken));
        var jwtConfig = config.GetSection("Jwt");
        var tokenHandler = new JwtSecurityTokenHandler();
        var key = Encoding.UTF8.GetBytes(jwtConfig["Secret"]!);

        TokenValidationParameters validationParameters = new()
        {
            ValidateIssuer = true,
            ValidIssuer = jwtConfig["Issuer"] ?? "vault-server",
            ValidateAudience = true,
            ValidAudience = jwtConfig["Audience"] ?? "vault-client",
            ValidateIssuerSigningKey = true,
            IssuerSigningKey = new SymmetricSecurityKey(key),
            ValidateLifetime = true,
            ClockSkew = TimeSpan.FromSeconds(15),
        };

        var principal = tokenHandler.ValidateToken(grantToken, validationParameters, out var validatedToken);
        var subject = principal.FindFirstValue(JwtRegisteredClaimNames.Sub)
            ?? principal.FindFirstValue(ClaimTypes.NameIdentifier)
            ?? throw new AccessDeniedException("View grant invalide.");
        logger.LogInformation("ReadViewGrantToken validated sub={Subject}", subject);
        if (subject != "view-grant" && !subject.StartsWith("view:", StringComparison.Ordinal))
        {
            logger.LogWarning("ReadViewGrantToken denied: unsupported sub={Subject}", subject);
            throw new AccessDeniedException("View grant invalide.");
        }

        string vaultId = principal.FindFirstValue("view_vault_id")
            ?? throw new AccessDeniedException("View grant invalide (vault).");
        string docId = principal.FindFirstValue("view_doc_id")
            ?? throw new AccessDeniedException("View grant invalide (document).");
        string path = principal.FindFirstValue("view_path")
            ?? throw new AccessDeniedException("View grant invalide (path).");
        string permission = principal.FindFirstValue("view_permission")
            ?? throw new AccessDeniedException("View grant invalide (permission).");
        string? userId = principal.FindFirstValue("view_user_id");

        // Keep expiration for response DTO. Use validated token metadata to avoid claim mapping differences.
        DateTime expiresAtUtc = validatedToken switch
        {
            JwtSecurityToken jwt => jwt.ValidTo.ToUniversalTime(),
            _ => DateTime.UtcNow.AddHours(8)
        };

        return new ViewGrantPayload(vaultId, docId, path, permission, userId, expiresAtUtc);
    }

    public string GenerateViewAccessToken(ViewGrantPayload payload)
    {
        var jwtConfig = config.GetSection("Jwt");
        var key = new SymmetricSecurityKey(
            Encoding.UTF8.GetBytes(jwtConfig["Secret"]!));

        var expires = DateTime.UtcNow.AddHours(8);
        var sub = $"view:{payload.VaultId}:{payload.DocId}:{payload.Permission}";

        var claims = new List<Claim>
        {
            new(JwtRegisteredClaimNames.Sub, sub),
            new(JwtRegisteredClaimNames.Jti, Guid.NewGuid().ToString()),
            new("view_vault_id", payload.VaultId),
            new("view_doc_id", payload.DocId),
            new("view_path", payload.Path),
            new("view_permission", payload.Permission),
        };
        if (!string.IsNullOrWhiteSpace(payload.UserId))
            claims.Add(new Claim("view_user_id", payload.UserId));

        var token = new JwtSecurityToken(
            issuer: jwtConfig["Issuer"] ?? "vault-server",
            audience: jwtConfig["Audience"] ?? "vault-client",
            claims: claims,
            expires: expires,
            signingCredentials: new SigningCredentials(key, SecurityAlgorithms.HmacSha256)
        );

        return new JwtSecurityTokenHandler().WriteToken(token);
    }

    private static string MaskPrefix(string? token)
    {
        if (string.IsNullOrWhiteSpace(token)) return "<empty>";
        int len = Math.Min(16, token.Length);
        return token[..len];
    }
}
