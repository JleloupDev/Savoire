// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Registre des verrous d'edition, en memoire.
//
// Un verrou n'est PAS une donnee metier : il ne survit pas au redemarrage, et
// c'est voulu. Un serveur qui redemarre libere tout — mieux vaut ca qu'un
// document verrouille a jamais par une session morte. Meme arbitrage que
// EdgeSyncRooms.Owners pour la genese d'un vault.
//
// L'arbitrage doit etre central : deux clients qui demandent le verrou en meme
// temps ne peuvent pas trancher entre eux. TryAcquire est atomique.

using System.Collections.Concurrent;

namespace Savoire.Server.Hubs;

public sealed record LockHolder(string UserId, string DisplayName, string ConnectionId);

public sealed class DocumentLockRegistry
{
    // clef : "{vaultId}/{docId}"
    private readonly ConcurrentDictionary<string, LockHolder> _locks = new();

    private static string Key(string vaultId, string docId) => $"{vaultId}/{docId}";

    /// <summary>Prend le verrou s'il est libre. Rend le detenteur effectif dans tous les cas.</summary>
    public LockHolder TryAcquire(string vaultId, string docId, LockHolder candidate)
        => _locks.GetOrAdd(Key(vaultId, docId), candidate);

    /// <summary>Libere le verrou si l'appelant le detient. Rend true s'il a bien ete libere.</summary>
    public bool Release(string vaultId, string docId, string connectionId)
    {
        string key = Key(vaultId, docId);
        if (!_locks.TryGetValue(key, out LockHolder? holder)) return false;
        if (holder.ConnectionId != connectionId) return false;
        return _locks.TryRemove(new KeyValuePair<string, LockHolder>(key, holder));
    }

    public LockHolder? Get(string vaultId, string docId)
        => _locks.TryGetValue(Key(vaultId, docId), out LockHolder? h) ? h : null;

    /// <summary>
    /// Libere tout ce que detenait une connexion qui s'en va. Sans cela, fermer
    /// un onglet laisserait le document verrouille pour tout le monde.
    /// Rend les clefs liberees, pour prevenir les autres.
    /// </summary>
    public IReadOnlyList<string> ReleaseAllFor(string connectionId)
    {
        var freed = new List<string>();
        foreach (var (key, holder) in _locks)
        {
            if (holder.ConnectionId != connectionId) continue;
            if (_locks.TryRemove(new KeyValuePair<string, LockHolder>(key, holder))) freed.Add(key);
        }
        return freed;
    }
}
