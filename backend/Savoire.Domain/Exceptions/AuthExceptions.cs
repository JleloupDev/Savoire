// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
using Microsoft.AspNetCore.Identity;

namespace Savoire.Domain.Exceptions;

public class InvalidEmailException(string email)
    : Exception($"Email invalide : '{email}'.");

public class EmailAlreadyUsedException(string email)
    : Exception($"L'email '{email}' est déjà associé à un compte.");

public class AccountLockedException()
    : Exception("Compte temporairement verrouillé.");

public class UserNotFoundException(string userId)
    : Exception($"Utilisateur '{userId}' introuvable.");

public class IdentityOperationException(IEnumerable<IdentityError> errors)
    : Exception(string.Join(", ", errors.Select(e => e.Description)));

// Le fournisseur d'identite a refuse une operation, ou n'a pas repondu.
public class IdentityProviderException(string detail)
    : Exception(detail);
