// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
using Microsoft.AspNetCore.Identity;

namespace Savoire.Domain.Exceptions;

public class InvalidEmailException(string email)
    : Exception($"Email invalide : '{email}'.");

public class EmailAlreadyUsedException(string email)
    : Exception($"L'email '{email}' est déjà associé à un compte.");

public class InvalidCredentialsException()
    : Exception("Identifiants incorrects.");

public class InvalidRefreshTokenException(string message)
    : Exception(message);

public class AccountLockedException()
    : Exception("Compte temporairement verrouillé.");

public class UserNotFoundException(string userId)
    : Exception($"Utilisateur '{userId}' introuvable.");

public class IdentityOperationException(IEnumerable<IdentityError> errors)
    : Exception(string.Join(", ", errors.Select(e => e.Description)));
