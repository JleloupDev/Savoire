// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// DatabaseInitializer — EnsureCreated + seed "default" vault.

using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;

namespace Savoire.Infrastructure.Persistence;

public static class DatabaseInitializer
{
    public static void Initialize(AppDbContext db)
    {
        // For test/POC environments: if database creation fails due to existing tables,
        // delete and recreate to ensure clean state
        try
        {
            db.Database.EnsureCreated();
        }
        catch (SqliteException ex) when (ex.SqliteErrorCode == 1 || ex.Message.Contains("already exists"))
        {
            // This can happen in test scenarios when the database file persists
            // but EnsureCreated thinks it needs to create tables

            // Close any open connections before attempting to delete
            db.Database.CloseConnection();

            db.Database.EnsureDeleted();
            db.Database.EnsureCreated();
        }

        db.Database.ExecuteSqlRaw("PRAGMA journal_mode=WAL;");

        // Vault "default" pour rétrocompatibilité (idempotent)
        if (!db.Vaults.Any(v => v.Id == "default"))
        {
            db.Vaults.Add(new VaultEntity
            {
                Id        = "default",
                Name      = "Default Vault",
                OwnerId   = "system",
                CreatedAt = DateTime.UtcNow
            });
            db.SaveChanges();
        }
    }
}
