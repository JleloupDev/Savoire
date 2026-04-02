// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// Global exception handler — maps Domain exceptions to Problem Details RFC 7807.

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
            InvalidCredentialsException  => (401, "invalid-credentials",   "Invalid credentials"),
            AccountLockedException       => (401, "account-locked",        "Account locked"),
            InvalidRefreshTokenException => (401, "invalid-refresh-token", "Invalid token"),
            UnauthorizedAccessException  => (401, "unauthorized",          "Not authenticated"),
            // Identity
            EmailAlreadyUsedException    => (400, "email-already-used",    "Email already in use"),
            IdentityOperationException   => (400, "identity-error",        "Account error"),
            InvalidEmailException        => (400, "invalid-email",         "Invalid email"),
            // Validation MediatR
            ValidationException          => (400, "validation-error",      "Invalid data"),
            // Resources
            VaultNotFoundException        => (404, "vault-not-found",      "Vault not found"),
            DocumentNotFoundException     => (404, "document-not-found",   "Document not found"),
            FolderNotFoundException       => (404, "folder-not-found",     "Folder not found"),
            UserNotFoundException         => (404, "user-not-found",       "User not found"),
            // Access / Conflicts
            AccessDeniedException         => (403, "access-denied",        "Access denied"),
            PathConflictException         => (409, "path-conflict",        "Path already in use"),
            FolderNotEmptyException       => (400, "folder-not-empty",     "Folder not empty"),
            _                             => (500, "internal-error",       "Internal error")
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
