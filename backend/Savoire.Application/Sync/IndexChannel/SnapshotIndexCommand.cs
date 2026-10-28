// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// Compaction d'un canal d'index (ADR-027, etape 8 : index partage compacte).
//
// Le journal d'un canal d'index grossissait sans fin : chaque arrivee le
// rejouait en entier. Un client qui a rejoue un journal trop long renvoie son
// etat Yjs complet ; le serveur remplace par cet etat EXACTEMENT les ops que
// ce client a recues a JoinIndex (identifiants gardes par le hub pour la
// connexion). Pourquoi c'est sur, meme a plusieurs :
//  - l'etat d'un client contient tout ce qu'il a rejoue : remplacer ces ops
//    par lui ne perd rien ;
//  - une op arrivee depuis (autre client) n'est pas dans la liste : elle reste ;
//  - deux compactions concurrentes sur les memes ops : la premiere les
//    remplace, la seconde n'en trouve plus et n'ecrit rien. Sur des listes
//    qui se recouvrent en partie, les deux etats restent : des etats Yjs se
//    fusionnent sans perte (mises a jour idempotentes et commutatives).
// Le serveur ne lit toujours rien : il deplace des octets opaques.

using MediatR;
using Savoire.Application.Common;
using Savoire.Domain.Aggregates;
using Savoire.Domain.Repositories;

namespace Savoire.Application.Sync.IndexChannel;

/// <summary>Memes droits que PushIndexUpdate : ecrire dans le vault.</summary>
public sealed record SnapshotIndexCommand(
    string CallerId, string VaultId, string Namespace, byte[] SnapshotBytes, IReadOnlyCollection<string> ReplacedOpIds)
    : IRequest<int>, IRequiresVaultAccess
{
    public VaultAccessLevel RequiredAccess => VaultAccessLevel.Write;
}

public sealed class SnapshotIndexCommandHandler(ICrdtOpRepository ops)
    : IRequestHandler<SnapshotIndexCommand, int>
{
    public Task<int> Handle(SnapshotIndexCommand cmd, CancellationToken ct) =>
        ops.ReplaceAsync(CrdtResourceType.Index, IndexResource.Id(cmd.VaultId, cmd.Namespace),
            cmd.ReplacedOpIds, cmd.SnapshotBytes, ct);
}
