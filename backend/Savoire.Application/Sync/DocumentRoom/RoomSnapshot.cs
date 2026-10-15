// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
using System.Text;
using MediatR;
using Savoire.Application.Common;
using Savoire.Domain.Aggregates;
using Savoire.Domain.Repositories;

namespace Savoire.Application.Sync.DocumentRoom;

// Rooms des documents « snapshot » (Excalidraw, table, mindmap...) : le
// dernier snapshot complet est garde, en dernier-ecrivain-gagne. L'entree et
// l'ecriture passent par le controle d'acces au document, comme les notes CRDT.

/// <summary>Entrer dans la room d'un document : rend son dernier snapshot, ou null.</summary>
public sealed record JoinRoomQuery(string CallerId, string VaultId, string DocId)
    : IRequest<string?>, IRequiresDocumentAccess
{
    public VaultAccessLevel RequiredAccess => VaultAccessLevel.Read;
}

public sealed class JoinRoomQueryHandler(ICrdtOpRepository ops) : IRequestHandler<JoinRoomQuery, string?>
{
    public async Task<string?> Handle(JoinRoomQuery q, CancellationToken ct)
    {
        // Le journal d'une room ne garde qu'un snapshot compacte.
        var history = await ops.GetAllAsync(CrdtResourceType.Room, q.DocId, ct);
        return history.Count > 0 ? Encoding.UTF8.GetString(history[^1].OpBytes) : null;
    }
}

/// <summary>Remplacer le snapshot d'un document.</summary>
public sealed record PushRoomSnapshotCommand(string CallerId, string VaultId, string DocId, string SnapshotJson)
    : IRequest, IRequiresDocumentAccess
{
    public VaultAccessLevel RequiredAccess => VaultAccessLevel.Write;
}

public sealed class PushRoomSnapshotCommandHandler(ICrdtOpRepository ops) : IRequestHandler<PushRoomSnapshotCommand>
{
    public Task Handle(PushRoomSnapshotCommand cmd, CancellationToken ct) =>
        // TODO(perf) : CompactAsync efface puis reinsere a chaque ecriture.
        ops.CompactAsync(CrdtResourceType.Room, cmd.DocId, Encoding.UTF8.GetBytes(cmd.SnapshotJson), force: true, ct);
}
