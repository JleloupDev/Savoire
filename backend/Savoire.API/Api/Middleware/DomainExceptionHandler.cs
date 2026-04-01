// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// Handler d'exceptions global — mappe les exceptions Domain vers Problem Details RFC 7807.

using FluentValidation;
using Microsoft.AspNetCore.Diagnostics;
using Microsoft.AspNetCore.Mvc;
using Savoire.Domain.Exceptions;

namespace Savoire.Server.Middleware;

public class DomainExceptionHandler : IExceptionHandler
{
    public async ValueTask<bool> TryHandleAsync(
        HttpContext context,
        Exception exception,
        CancellationToken ct)
    {
        (int status, string type, string title) = exception switch
        {
            // Auth
            InvalidCredentialsException  => (401, "invalid-credentials",   "Identifiants incorrects"),
            AccountLockedException       => (401, "account-locked",        "Compte verrouillé"),
            InvalidRefreshTokenException => (401, "invalid-refresh-token", "Token invalide"),
            UnauthorizedAccessException  => (401, "unauthorized",          "Non authentifié"),
            // Identity
            EmailAlreadyUsedException    => (400, "email-already-used",    "Email déjà utilisé"),
            IdentityOperationException   => (400, "identity-error",        "Erreur de compte"),
            InvalidEmailException        => (400, "invalid-email",         "Email invalide"),
            // Validation MediatR
            ValidationException          => (400, "validation-error",      "Données invalides"),
            // Ressources
            VaultNotFoundException        => (404, "vault-not-found",      "Vault introuvable"),
            DocumentNotFoundException     => (404, "document-not-found",   "Document introuvable"),
            FolderNotFoundException       => (404, "folder-not-found",     "Dossier introuvable"),
            UserNotFoundException         => (404, "user-not-found",       "Utilisateur introuvable"),
            // Accès / Conflits
            AccessDeniedException         => (403, "access-denied",        "Accès refusé"),
            PathConflictException         => (409, "path-conflict",        "Chemin déjà utilisé"),
            FolderNotEmptyException       => (400, "folder-not-empty",     "Dossier non vide"),
            _                             => (500, "internal-error",       "Erreur interne")
        };

        context.Response.StatusCode = status;
        await context.Response.WriteAsJsonAsync(new ProblemDetails
        {
            Type   = $"https://errors.app/{type}",
            Title  = title,
            Status = status,
            Detail = exception.Message
        }, ct);

        return true;
    }
}
