// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
using Savoire.Application.Sharing;
using Savoire.Domain.Exceptions;

namespace Savoire.Application.Indexer;

public static class IndexerCallers
{
    /// <summary>
    /// Un lien de partage (share:...) ou un jeton de lecture (view:...) ne
    /// donne acces a aucune route du pair indexeur : il ouvre une note, pas
    /// une recherche sur tout le vault. Seul un compte membre passe.
    /// </summary>
    public static void RequireAccount(string callerId)
    {
        if (ShareLinkGuard.IsShareLinkCaller(callerId) || ShareLinkGuard.IsViewCaller(callerId))
            throw new AccessDeniedException("Un lien de partage ne donne pas acces au pair indexeur.");
    }
}
