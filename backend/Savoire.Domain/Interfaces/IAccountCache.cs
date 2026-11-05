// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
namespace Savoire.Domain.Interfaces;

/// <summary>
/// Etat des comptes garde en memoire pendant la validation des jetons
/// (administrateur, bloque). A oublier quand un compte change.
/// </summary>
public interface IAccountCache
{
    void Forget(string userId);
}
