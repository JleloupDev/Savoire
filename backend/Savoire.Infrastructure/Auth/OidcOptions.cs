// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Fournisseur d'identite (ADR-028) : section « Auth:Oidc ».
// La connexion, l'inscription et les mots de passe vivent chez lui (Zitadel) ;
// Savoire ne garde que les comptes (relies au sujet « sub ») et leurs droits.
// deploy/compose/zitadel/bootstrap.mjs ecrit ces valeurs.

namespace Savoire.Infrastructure.Auth;

public sealed class OidcOptions
{
    public const string Section = "Auth:Oidc";

    /// <summary>Emetteur public (ex. https://auth.exemple.fr). Vide : aucune connexion possible.</summary>
    public string? Authority { get; set; }

    /// <summary>Audience attendue dans les jetons : l'id du projet Savoire chez l'IdP.</summary>
    public string? Audience { get; set; }

    /// <summary>Appli web (navigateur, code + PKCE).</summary>
    public string? WebClientId { get; set; }

    /// <summary>Appli de bureau (native, retour sur 127.0.0.1).</summary>
    public string? DesktopClientId { get; set; }

    /// <summary>Faux seulement en dev (IdP en http).</summary>
    public bool RequireHttpsMetadata { get; set; } = true;

    /// <summary>Portees demandees par les clients.</summary>
    public string Scopes { get; set; } = "openid profile email offline_access";

    public bool Enabled => !string.IsNullOrWhiteSpace(Authority) && !string.IsNullOrWhiteSpace(Audience);
}

/// <summary>Section « Auth » : reglages propres a Savoire.</summary>
public sealed class AuthOptions
{
    public const string Section = "Auth";

    /// <summary>
    /// Adresses des administrateurs de l'instance. Un compte dont l'adresse,
    /// verifiee par l'IdP, est dans cette liste devient administrateur.
    /// </summary>
    public string[] AdminEmails { get; set; } = [];
}
