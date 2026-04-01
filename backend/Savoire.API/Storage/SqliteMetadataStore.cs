// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// Implémentation SQLite de IMetadataStore — Milestone 1
// see ADR-019
// Le schéma est initialisé par DatabaseInitializer au démarrage (pas dans ce constructeur).

using Microsoft.Data.Sqlite;
using Savoire.Server.Models;

namespace Savoire.Server.Storage;

public class SqliteMetadataStore : IMetadataStore
{
    private readonly string _connString;

    public SqliteMetadataStore(string dbPath)
    {
        _connString = $"Data Source={dbPath}";
    }

    private SqliteConnection Open()
    {
        var conn = new SqliteConnection(_connString);
        conn.Open();
        return conn;
    }

    private static void Execute(SqliteConnection conn, string sql, Action<SqliteCommand>? setup = null)
    {
        using var cmd = conn.CreateCommand();
        cmd.CommandText = sql;
        setup?.Invoke(cmd);
        cmd.ExecuteNonQuery();
    }

    // ── Documents ──────────────────────────────────────────────────────────────

    public async Task<DocumentRecord?> GetDocumentAsync(string docId, CancellationToken ct = default)
    {
        using SqliteConnection conn = Open();
        using var cmd = conn.CreateCommand();
        cmd.CommandText = """
            SELECT id, vault_id, path, title, size_bytes, hash, created_at, updated_at, deleted_at
            FROM documents WHERE id = $id
            """;
        cmd.Parameters.AddWithValue("$id", docId);
        using SqliteDataReader r = await cmd.ExecuteReaderAsync(ct);
        return await r.ReadAsync(ct) ? MapDocument(r) : null;
    }

    public async Task<DocumentRecord?> GetDocumentByPathAsync(
        string vaultId, string path, CancellationToken ct = default)
    {
        using SqliteConnection conn = Open();
        using var cmd = conn.CreateCommand();
        cmd.CommandText = """
            SELECT id, vault_id, path, title, size_bytes, hash, created_at, updated_at, deleted_at
            FROM documents WHERE vault_id = $vaultId AND path = $path AND deleted_at IS NULL
            """;
        cmd.Parameters.AddWithValue("$vaultId", vaultId);
        cmd.Parameters.AddWithValue("$path", path);
        using SqliteDataReader r = await cmd.ExecuteReaderAsync(ct);
        return await r.ReadAsync(ct) ? MapDocument(r) : null;
    }

    public async Task<IReadOnlyList<DocumentRecord>> ListVaultDocumentsAsync(
        string vaultId,
        string? folderPrefix = null,
        bool includeDeleted = false,
        CancellationToken ct = default)
    {
        using SqliteConnection conn = Open();
        using var cmd = conn.CreateCommand();

        var where = new List<string> { "vault_id = $vaultId" };
        if (!includeDeleted) where.Add("deleted_at IS NULL");
        if (folderPrefix is not null) where.Add("path LIKE $prefix");

        cmd.CommandText = $"""
            SELECT id, vault_id, path, title, size_bytes, hash, created_at, updated_at, deleted_at
            FROM documents
            WHERE {string.Join(" AND ", where)}
            ORDER BY path
            """;
        cmd.Parameters.AddWithValue("$vaultId", vaultId);
        if (folderPrefix is not null)
            cmd.Parameters.AddWithValue("$prefix", folderPrefix.TrimEnd('/') + "/%");

        using SqliteDataReader r = await cmd.ExecuteReaderAsync(ct);
        var list = new List<DocumentRecord>();
        while (await r.ReadAsync(ct)) list.Add(MapDocument(r));
        return list;
    }

    public async Task UpsertDocumentAsync(DocumentRecord doc, CancellationToken ct = default)
    {
        using SqliteConnection conn = Open();
        using var cmd = conn.CreateCommand();
        cmd.CommandText = """
            INSERT INTO documents (id, vault_id, path, title, size_bytes, hash, created_at, updated_at, deleted_at)
            VALUES ($id, $vault_id, $path, $title, $size_bytes, $hash, $created_at, $updated_at, $deleted_at)
            ON CONFLICT(id) DO UPDATE SET
                path       = excluded.path,
                title      = excluded.title,
                size_bytes = excluded.size_bytes,
                hash       = excluded.hash,
                updated_at = excluded.updated_at,
                deleted_at = excluded.deleted_at
            """;
        cmd.Parameters.AddWithValue("$id",         doc.Id);
        cmd.Parameters.AddWithValue("$vault_id",   doc.VaultId);
        cmd.Parameters.AddWithValue("$path",       doc.Path);
        cmd.Parameters.AddWithValue("$title",      (object?)doc.Title ?? DBNull.Value);
        cmd.Parameters.AddWithValue("$size_bytes", doc.SizeBytes);
        cmd.Parameters.AddWithValue("$hash",       doc.Hash);
        cmd.Parameters.AddWithValue("$created_at", doc.CreatedAt.ToString("O"));
        cmd.Parameters.AddWithValue("$updated_at", doc.UpdatedAt.ToString("O"));
        cmd.Parameters.AddWithValue("$deleted_at", (object?)doc.DeletedAt?.ToString("O") ?? DBNull.Value);
        await cmd.ExecuteNonQueryAsync(ct);
    }

    public async Task RenameDocumentAsync(string docId, string newPath, CancellationToken ct = default)
    {
        using SqliteConnection conn = Open();
        using var cmd = conn.CreateCommand();
        cmd.CommandText = """
            UPDATE documents SET path = $path, updated_at = $updated_at WHERE id = $id
            """;
        cmd.Parameters.AddWithValue("$id",         docId);
        cmd.Parameters.AddWithValue("$path",       newPath);
        cmd.Parameters.AddWithValue("$updated_at", DateTime.UtcNow.ToString("O"));
        await cmd.ExecuteNonQueryAsync(ct);
    }

    public async Task SoftDeleteDocumentAsync(string docId, CancellationToken ct = default)
    {
        using SqliteConnection conn = Open();
        using var cmd = conn.CreateCommand();
        cmd.CommandText = "UPDATE documents SET deleted_at = $d WHERE id = $id";
        cmd.Parameters.AddWithValue("$id", docId);
        cmd.Parameters.AddWithValue("$d",  DateTime.UtcNow.ToString("O"));
        await cmd.ExecuteNonQueryAsync(ct);
    }

    public async Task<IReadOnlyList<DocumentRecord>> GetDocumentChangesSinceAsync(
        string vaultId, DateTime since, CancellationToken ct = default)
    {
        using SqliteConnection conn = Open();
        using var cmd = conn.CreateCommand();
        cmd.CommandText = """
            SELECT id, vault_id, path, title, size_bytes, hash, created_at, updated_at, deleted_at
            FROM documents
            WHERE vault_id = $vaultId AND updated_at >= $since
            ORDER BY updated_at ASC
            """;
        cmd.Parameters.AddWithValue("$vaultId", vaultId);
        cmd.Parameters.AddWithValue("$since",   since.ToString("O"));
        using SqliteDataReader r = await cmd.ExecuteReaderAsync(ct);
        var list = new List<DocumentRecord>();
        while (await r.ReadAsync(ct)) list.Add(MapDocument(r));
        return list;
    }

    // ── Dossiers ───────────────────────────────────────────────────────────────

    public async Task CreateFolderAsync(FolderRecord folder, CancellationToken ct = default)
    {
        using SqliteConnection conn = Open();
        using var cmd = conn.CreateCommand();
        cmd.CommandText = """
            INSERT OR IGNORE INTO folders (id, vault_id, path, created_at)
            VALUES ($id, $vault_id, $path, $created_at)
            """;
        cmd.Parameters.AddWithValue("$id",         folder.Id);
        cmd.Parameters.AddWithValue("$vault_id",   folder.VaultId);
        cmd.Parameters.AddWithValue("$path",       folder.Path);
        cmd.Parameters.AddWithValue("$created_at", folder.CreatedAt.ToString("O"));
        await cmd.ExecuteNonQueryAsync(ct);
    }

    public async Task<FolderRecord?> GetFolderAsync(string folderId, CancellationToken ct = default)
    {
        using SqliteConnection conn = Open();
        using var cmd = conn.CreateCommand();
        cmd.CommandText = "SELECT id, vault_id, path, created_at FROM folders WHERE id = $id";
        cmd.Parameters.AddWithValue("$id", folderId);
        using SqliteDataReader r = await cmd.ExecuteReaderAsync(ct);
        return await r.ReadAsync(ct) ? MapFolder(r) : null;
    }

    public async Task<FolderRecord?> GetFolderByPathAsync(
        string vaultId, string path, CancellationToken ct = default)
    {
        using SqliteConnection conn = Open();
        using var cmd = conn.CreateCommand();
        cmd.CommandText = """
            SELECT id, vault_id, path, created_at FROM folders
            WHERE vault_id = $vaultId AND path = $path
            """;
        cmd.Parameters.AddWithValue("$vaultId", vaultId);
        cmd.Parameters.AddWithValue("$path",    path);
        using SqliteDataReader r = await cmd.ExecuteReaderAsync(ct);
        return await r.ReadAsync(ct) ? MapFolder(r) : null;
    }

    public async Task<IReadOnlyList<FolderRecord>> ListVaultFoldersAsync(
        string vaultId, CancellationToken ct = default)
    {
        using SqliteConnection conn = Open();
        using var cmd = conn.CreateCommand();
        cmd.CommandText = """
            SELECT id, vault_id, path, created_at FROM folders
            WHERE vault_id = $vaultId ORDER BY path
            """;
        cmd.Parameters.AddWithValue("$vaultId", vaultId);
        using SqliteDataReader r = await cmd.ExecuteReaderAsync(ct);
        var list = new List<FolderRecord>();
        while (await r.ReadAsync(ct)) list.Add(MapFolder(r));
        return list;
    }

    public async Task<(int MovedFolders, int MovedDocuments)> MoveFolderAsync(
        string folderId, string newPath, CancellationToken ct = default)
    {
        using SqliteConnection conn = Open();

        // Récupérer le path actuel du dossier
        FolderRecord? folder = await GetFolderAsync(folderId, ct);
        if (folder is null) return (0, 0);

        string oldPath   = folder.Path;
        string oldPrefix = oldPath + "/";
        string newPrefix = newPath + "/";

        // Mettre à jour le dossier lui-même
        using var cmd1 = conn.CreateCommand();
        cmd1.CommandText = "UPDATE folders SET path = $newPath WHERE id = $id";
        cmd1.Parameters.AddWithValue("$id",      folderId);
        cmd1.Parameters.AddWithValue("$newPath", newPath);
        await cmd1.ExecuteNonQueryAsync(ct);

        // Mettre à jour les sous-dossiers (path LIKE oldPath/%)
        using var cmd2 = conn.CreateCommand();
        cmd2.CommandText = """
            UPDATE folders
            SET path = $newPrefix || substr(path, $oldPrefixLen + 1)
            WHERE vault_id = $vaultId AND path LIKE $pattern
            """;
        cmd2.Parameters.AddWithValue("$vaultId",      folder.VaultId);
        cmd2.Parameters.AddWithValue("$newPrefix",    newPrefix);
        cmd2.Parameters.AddWithValue("$oldPrefixLen", oldPrefix.Length);
        cmd2.Parameters.AddWithValue("$pattern",      oldPrefix + "%");
        int movedFolders = await cmd2.ExecuteNonQueryAsync(ct);

        // Mettre à jour les documents dont le path commence par oldPath/
        using var cmd3 = conn.CreateCommand();
        cmd3.CommandText = """
            UPDATE documents
            SET path = $newPrefix || substr(path, $oldPrefixLen + 1),
                updated_at = $updatedAt
            WHERE vault_id = $vaultId AND path LIKE $pattern AND deleted_at IS NULL
            """;
        cmd3.Parameters.AddWithValue("$vaultId",      folder.VaultId);
        cmd3.Parameters.AddWithValue("$newPrefix",    newPrefix);
        cmd3.Parameters.AddWithValue("$oldPrefixLen", oldPrefix.Length);
        cmd3.Parameters.AddWithValue("$pattern",      oldPrefix + "%");
        cmd3.Parameters.AddWithValue("$updatedAt",    DateTime.UtcNow.ToString("O"));
        int movedDocs = await cmd3.ExecuteNonQueryAsync(ct);

        return (movedFolders + 1, movedDocs);
    }

    public async Task<int> DeleteFolderRecursiveAsync(
        string folderId, DateTime deletedAt, CancellationToken ct = default)
    {
        FolderRecord? folder = await GetFolderAsync(folderId, ct);
        if (folder is null) return 0;

        string folderPath = folder.Path;
        string prefix     = folderPath + "/";

        using SqliteConnection conn = Open();

        // Soft-delete documents dans ce dossier et sous-dossiers
        using var cmd1 = conn.CreateCommand();
        cmd1.CommandText = """
            UPDATE documents SET deleted_at = $d
            WHERE vault_id = $vaultId
              AND (path LIKE $prefix OR path LIKE $exact)
              AND deleted_at IS NULL
            """;
        cmd1.Parameters.AddWithValue("$vaultId", folder.VaultId);
        cmd1.Parameters.AddWithValue("$d",       deletedAt.ToString("O"));
        cmd1.Parameters.AddWithValue("$prefix",  prefix + "%");
        cmd1.Parameters.AddWithValue("$exact",   folderPath + "/%.md");
        int deleted = await cmd1.ExecuteNonQueryAsync(ct);

        // Also delete documents exactly in this folder (path starts with folderPath/)
        // (already handled by LIKE $prefix above)

        // Supprimer les sous-dossiers
        using var cmd2 = conn.CreateCommand();
        cmd2.CommandText = """
            DELETE FROM folders
            WHERE vault_id = $vaultId AND (id = $id OR path LIKE $pattern)
            """;
        cmd2.Parameters.AddWithValue("$vaultId", folder.VaultId);
        cmd2.Parameters.AddWithValue("$id",      folderId);
        cmd2.Parameters.AddWithValue("$pattern", prefix + "%");
        await cmd2.ExecuteNonQueryAsync(ct);

        return deleted;
    }

    public async Task<bool> FolderHasDocumentsAsync(
        string vaultId, string folderPath, CancellationToken ct = default)
    {
        using SqliteConnection conn = Open();
        using var cmd = conn.CreateCommand();
        cmd.CommandText = """
            SELECT COUNT(*) FROM documents
            WHERE vault_id = $vaultId AND path LIKE $pattern AND deleted_at IS NULL
            """;
        cmd.Parameters.AddWithValue("$vaultId", vaultId);
        cmd.Parameters.AddWithValue("$pattern", folderPath.TrimEnd('/') + "/%");
        object? result = await cmd.ExecuteScalarAsync(ct);
        return Convert.ToInt32(result) > 0;
    }

    // ── Operations CRDT ────────────────────────────────────────────────────────

    public async Task AppendOperationAsync(OperationRecord op, CancellationToken ct = default)
    {
        using SqliteConnection conn = Open();
        using var cmd = conn.CreateCommand();
        cmd.CommandText = """
            INSERT OR IGNORE INTO operations_log (id, document_id, client_id, produced_at, received_at, op_bytes)
            VALUES ($id, $document_id, $client_id, $produced_at, $received_at, $op_bytes)
            """;
        cmd.Parameters.AddWithValue("$id",          op.Id);
        cmd.Parameters.AddWithValue("$document_id", op.DocumentId);
        cmd.Parameters.AddWithValue("$client_id",   op.ClientId);
        cmd.Parameters.AddWithValue("$produced_at", op.ProducedAt.ToString("O"));
        cmd.Parameters.AddWithValue("$received_at", op.ReceivedAt.ToString("O"));
        cmd.Parameters.AddWithValue("$op_bytes",    op.OpBytes);
        await cmd.ExecuteNonQueryAsync(ct);
    }

    public async Task<IReadOnlyList<OperationRecord>> GetOperationsSinceAsync(
        string docId, DateTime since, CancellationToken ct = default)
    {
        using SqliteConnection conn = Open();
        using var cmd = conn.CreateCommand();
        cmd.CommandText = """
            SELECT id, document_id, client_id, produced_at, received_at, op_bytes
            FROM operations_log
            WHERE document_id = $docId AND received_at >= $since
            ORDER BY received_at ASC
            """;
        cmd.Parameters.AddWithValue("$docId", docId);
        cmd.Parameters.AddWithValue("$since", since.ToString("O"));
        using SqliteDataReader r = await cmd.ExecuteReaderAsync(ct);
        var list = new List<OperationRecord>();
        while (await r.ReadAsync(ct)) list.Add(MapOperation(r));
        return list;
    }

    // ── Vecteurs d'état ────────────────────────────────────────────────────────

    public async Task<byte[]?> GetSyncVectorAsync(
        string docId, string clientId, CancellationToken ct = default)
    {
        using SqliteConnection conn = Open();
        using var cmd = conn.CreateCommand();
        cmd.CommandText = "SELECT vector FROM sync_vectors WHERE document_id = $d AND client_id = $c";
        cmd.Parameters.AddWithValue("$d", docId);
        cmd.Parameters.AddWithValue("$c", clientId);
        object? result = await cmd.ExecuteScalarAsync(ct);
        return result is DBNull or null ? null : (byte[])result;
    }

    public async Task SetSyncVectorAsync(
        string docId, string clientId, byte[] vector, CancellationToken ct = default)
    {
        using SqliteConnection conn = Open();
        using var cmd = conn.CreateCommand();
        cmd.CommandText = """
            INSERT INTO sync_vectors (document_id, client_id, vector, updated_at)
            VALUES ($d, $c, $v, $u)
            ON CONFLICT(document_id, client_id) DO UPDATE SET
                vector = excluded.vector, updated_at = excluded.updated_at
            """;
        cmd.Parameters.AddWithValue("$d", docId);
        cmd.Parameters.AddWithValue("$c", clientId);
        cmd.Parameters.AddWithValue("$v", vector);
        cmd.Parameters.AddWithValue("$u", DateTime.UtcNow.ToString("O"));
        await cmd.ExecuteNonQueryAsync(ct);
    }

    // ── Vaults ────────────────────────────────────────────────────────────────

    public async Task<VaultRecord?> GetVaultAsync(string vaultId, CancellationToken ct = default)
    {
        using SqliteConnection conn = Open();
        using var cmd = conn.CreateCommand();
        cmd.CommandText = "SELECT id, name, owner_id, created_at FROM vaults WHERE id = $id";
        cmd.Parameters.AddWithValue("$id", vaultId);
        using SqliteDataReader r = await cmd.ExecuteReaderAsync(ct);
        if (!await r.ReadAsync(ct)) return null;
        return new VaultRecord(r.GetString(0), r.GetString(1), r.GetString(2), DateTime.Parse(r.GetString(3)));
    }

    public async Task<IReadOnlyList<VaultMember>> GetVaultMembersAsync(
        string vaultId, CancellationToken ct = default)
    {
        using SqliteConnection conn = Open();
        using var cmd = conn.CreateCommand();
        cmd.CommandText = "SELECT vault_id, user_id, role, joined_at FROM vault_members WHERE vault_id = $v";
        cmd.Parameters.AddWithValue("$v", vaultId);
        using SqliteDataReader r = await cmd.ExecuteReaderAsync(ct);
        var list = new List<VaultMember>();
        while (await r.ReadAsync(ct))
            list.Add(new VaultMember(r.GetString(0), r.GetString(1), r.GetString(2), DateTime.Parse(r.GetString(3))));
        return list;
    }

    public async Task CreateVaultAsync(VaultRecord vault, CancellationToken ct = default)
    {
        using SqliteConnection conn = Open();
        using var cmd = conn.CreateCommand();
        cmd.CommandText = """
            INSERT INTO vaults (id, name, owner_id, created_at)
            VALUES ($id, $name, $ownerId, $createdAt)
            """;
        cmd.Parameters.AddWithValue("$id",        vault.Id);
        cmd.Parameters.AddWithValue("$name",      vault.Name);
        cmd.Parameters.AddWithValue("$ownerId",   vault.OwnerId);
        cmd.Parameters.AddWithValue("$createdAt", vault.CreatedAt.ToString("O"));
        await cmd.ExecuteNonQueryAsync(ct);
    }

    public async Task RenameVaultAsync(string vaultId, string newName, CancellationToken ct = default)
    {
        using SqliteConnection conn = Open();
        using var cmd = conn.CreateCommand();
        cmd.CommandText = "UPDATE vaults SET name = $name WHERE id = $id";
        cmd.Parameters.AddWithValue("$id",   vaultId);
        cmd.Parameters.AddWithValue("$name", newName);
        await cmd.ExecuteNonQueryAsync(ct);
    }

    public async Task DeleteVaultAsync(string vaultId, CancellationToken ct = default)
    {
        using SqliteConnection conn = Open();
        using var cmd = conn.CreateCommand();
        // CASCADE supprime les membres, documents, dossiers et opérations liés
        cmd.CommandText = "DELETE FROM vaults WHERE id = $id";
        cmd.Parameters.AddWithValue("$id", vaultId);
        await cmd.ExecuteNonQueryAsync(ct);
    }

    public async Task<IReadOnlyList<(VaultRecord Vault, string Role)>> GetVaultsForUserAsync(
        string userId, CancellationToken ct = default)
    {
        using SqliteConnection conn = Open();
        using var cmd = conn.CreateCommand();
        cmd.CommandText = """
            SELECT v.id, v.name, v.owner_id, v.created_at,
                   CASE WHEN v.owner_id = $userId THEN 'owner' ELSE vm.role END AS role
            FROM vaults v
            LEFT JOIN vault_members vm ON v.id = vm.vault_id AND vm.user_id = $userId
            WHERE v.owner_id = $userId OR vm.user_id = $userId
            ORDER BY v.created_at ASC
            """;
        cmd.Parameters.AddWithValue("$userId", userId);
        using SqliteDataReader r = await cmd.ExecuteReaderAsync(ct);
        var list = new List<(VaultRecord, string)>();
        while (await r.ReadAsync(ct))
        {
            var vault = new VaultRecord(r.GetString(0), r.GetString(1), r.GetString(2), DateTime.Parse(r.GetString(3)));
            list.Add((vault, r.GetString(4)));
        }
        return list;
    }

    public async Task<VaultStats> GetVaultStatsAsync(string vaultId, CancellationToken ct = default)
    {
        using SqliteConnection conn = Open();
        using var cmd = conn.CreateCommand();
        cmd.CommandText = """
            SELECT
                (SELECT COUNT(*) FROM documents WHERE vault_id = $vaultId AND deleted_at IS NULL),
                (SELECT COUNT(*) FROM folders   WHERE vault_id = $vaultId),
                (SELECT MAX(updated_at) FROM documents WHERE vault_id = $vaultId AND deleted_at IS NULL),
                (SELECT COALESCE(SUM(size_bytes), 0) FROM documents WHERE vault_id = $vaultId AND deleted_at IS NULL)
            """;
        cmd.Parameters.AddWithValue("$vaultId", vaultId);
        using SqliteDataReader r = await cmd.ExecuteReaderAsync(ct);
        if (!await r.ReadAsync(ct)) return new VaultStats(0, 0, null, 0);
        int     docCount    = r.GetInt32(0);
        int     folderCount = r.GetInt32(1);
        string? lastStr     = r.IsDBNull(2) ? null : r.GetString(2);
        long    sizeBytes   = r.GetInt64(3);
        return new VaultStats(docCount, folderCount, lastStr is null ? null : DateTime.Parse(lastStr), sizeBytes);
    }

    // ── Membres ───────────────────────────────────────────────────────────────

    public async Task AddVaultMemberAsync(VaultMember member, CancellationToken ct = default)
    {
        using SqliteConnection conn = Open();
        using var cmd = conn.CreateCommand();
        cmd.CommandText = """
            INSERT INTO vault_members (vault_id, user_id, role, joined_at)
            VALUES ($vaultId, $userId, $role, $joinedAt)
            ON CONFLICT(vault_id, user_id) DO UPDATE SET
                role = excluded.role, joined_at = excluded.joined_at
            """;
        cmd.Parameters.AddWithValue("$vaultId",  member.VaultId);
        cmd.Parameters.AddWithValue("$userId",   member.UserId);
        cmd.Parameters.AddWithValue("$role",     member.Role);
        cmd.Parameters.AddWithValue("$joinedAt", member.JoinedAt.ToString("O"));
        await cmd.ExecuteNonQueryAsync(ct);
    }

    public async Task<VaultMember?> GetVaultMemberAsync(
        string vaultId, string userId, CancellationToken ct = default)
    {
        using SqliteConnection conn = Open();
        using var cmd = conn.CreateCommand();
        cmd.CommandText = """
            SELECT vault_id, user_id, role, joined_at
            FROM vault_members WHERE vault_id = $v AND user_id = $u
            """;
        cmd.Parameters.AddWithValue("$v", vaultId);
        cmd.Parameters.AddWithValue("$u", userId);
        using SqliteDataReader r = await cmd.ExecuteReaderAsync(ct);
        if (!await r.ReadAsync(ct)) return null;
        return new VaultMember(r.GetString(0), r.GetString(1), r.GetString(2), DateTime.Parse(r.GetString(3)));
    }

    public async Task RemoveMemberAsync(string vaultId, string userId, CancellationToken ct = default)
    {
        using SqliteConnection conn = Open();
        using var cmd = conn.CreateCommand();
        cmd.CommandText = "DELETE FROM vault_members WHERE vault_id = $v AND user_id = $u";
        cmd.Parameters.AddWithValue("$v", vaultId);
        cmd.Parameters.AddWithValue("$u", userId);
        await cmd.ExecuteNonQueryAsync(ct);
    }

    // ── Mappers ────────────────────────────────────────────────────────────────

    private static DocumentRecord MapDocument(SqliteDataReader r) => new(
        Id:        r.GetString(0),
        VaultId:   r.GetString(1),
        Path:      r.GetString(2),
        Title:     r.IsDBNull(3) ? null : r.GetString(3),
        SizeBytes: r.IsDBNull(4) ? 0    : r.GetInt64(4),
        Hash:      r.IsDBNull(5) ? ""   : r.GetString(5),
        CreatedAt: DateTime.Parse(r.GetString(6)),
        UpdatedAt: DateTime.Parse(r.GetString(7)),
        DeletedAt: r.IsDBNull(8) ? null : DateTime.Parse(r.GetString(8))
    );

    private static FolderRecord MapFolder(SqliteDataReader r) => new(
        Id:        r.GetString(0),
        VaultId:   r.GetString(1),
        Path:      r.GetString(2),
        CreatedAt: DateTime.Parse(r.GetString(3))
    );

    private static OperationRecord MapOperation(SqliteDataReader r) => new(
        Id:         r.GetString(0),
        DocumentId: r.GetString(1),
        ClientId:   r.GetString(2),
        ProducedAt: DateTime.Parse(r.GetString(3)),
        ReceivedAt: DateTime.Parse(r.GetString(4)),
        OpBytes:    (byte[])r.GetValue(5)
    );
}
