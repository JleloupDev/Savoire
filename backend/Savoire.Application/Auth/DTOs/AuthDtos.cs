// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
namespace Savoire.Application.Auth.DTOs;

/// <summary>
/// Ou et comment se connecter a ce serveur (ADR-028) : le fournisseur
/// d'identite et les applis qui y sont declarees. Public : le web et le
/// bureau le lisent avant toute connexion.
/// </summary>
public record AuthConfigDto(
    string Issuer,
    string WebClientId,
    string? DesktopClientId,
    string Scopes
);

public record AuthUserDto(string Id, string DisplayName, string Email, bool IsAdmin);
