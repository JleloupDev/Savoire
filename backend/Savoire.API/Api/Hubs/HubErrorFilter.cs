// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// HubErrorFilter - traduit les exceptions du domaine en HubException a code
// stable, pour tous les hubs.
//
// Sans lui, le client ne recoit que « An unexpected error occurred invoking
// 'X' on the server. » et ne peut pas distinguer un vault supprime (ou un
// acces retire) d'un alea : il reessaie en boucle. Le message d'une
// HubException, lui, arrive tel quel au client. Les regles d'acces ne
// changent pas : on ne fait que nommer le refus.

using Microsoft.AspNetCore.SignalR;
using Savoire.Domain.Exceptions;

namespace Savoire.Server.Hubs;

public sealed class HubErrorFilter(ILogger<HubErrorFilter> logger) : IHubFilter
{
    /// <summary>Le vault n'existe pas, ou l'appelant n'y a plus acces.</summary>
    public const string VaultNotFound = "vault-not-found";
    /// <summary>Le document n'est pas inscrit dans le vault annonce. Le vault, lui, peut exister.</summary>
    public const string DocumentNotInVault = "document-not-in-vault";
    /// <summary>Acces reconnu mais insuffisant (lecteur qui ecrit...).</summary>
    public const string AccessDenied = "access-denied";

    public async ValueTask<object?> InvokeMethodAsync(
        HubInvocationContext invocationContext,
        Func<HubInvocationContext, ValueTask<object?>> next)
    {
        try
        {
            return await next(invocationContext);
        }
        catch (Exception ex) when (CodeOf(ex) is string code)
        {
            // Avertissement court, sans pile : un refus attendu n'est pas une panne.
            logger.LogWarning("Hub {Hub}.{Method} refuse : {Code}",
                invocationContext.Hub.GetType().Name, invocationContext.HubMethodName, code);
            throw new HubException(code);
        }
    }

    /// <summary>Code stable d'une exception connue, ou null (l'exception passe telle quelle).</summary>
    public static string? CodeOf(Exception ex) => ex switch
    {
        DocumentNotInVaultException => DocumentNotInVault,
        VaultNotFoundException      => VaultNotFound,
        AccessDeniedException       => AccessDenied,
        _                           => null,
    };
}
