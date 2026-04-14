// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// V1 implementation of IUserLookupService: accounts defined in appsettings.json.

using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging;
using Savoire.Domain.Services;

namespace Savoire.Infrastructure.Users;

public class ConfigUserService : IUserLookupService
{
    private readonly IReadOnlyDictionary<string, UserInfo> _users;

    public ConfigUserService(IConfiguration config, ILogger<ConfigUserService> logger)
    {
        string storageRoot = config.GetValue<string>("Storage:Root") ?? "storage";

        List<UserConfig> configs = config.GetSection("Users").Get<List<UserConfig>>() ?? new();

        List<string> duplicates = configs
            .GroupBy(u => u.Id, StringComparer.OrdinalIgnoreCase)
            .Where(g => g.Count() > 1)
            .Select(g => g.Key)
            .ToList();

        if (duplicates.Count > 0)
        {
            string msg = $"Ids utilisateurs dupliqués : {string.Join(", ", duplicates)}";
            logger.LogError("{Message}", msg);
            throw new InvalidOperationException(msg);
        }

        _users = configs.ToDictionary(
            u => u.Id,
            u => new UserInfo(
                Id:               u.Id,
                DisplayName:      u.DisplayName,
                DefaultVaultPath: string.IsNullOrWhiteSpace(u.DefaultVaultPath)
                    ? Path.Combine(storageRoot, u.Id)
                    : u.DefaultVaultPath
            ),
            StringComparer.OrdinalIgnoreCase
        );

        logger.LogInformation("ConfigUserService : {Count} utilisateur(s) : {Ids}",
            _users.Count, string.Join(", ", _users.Keys));
    }

    public Task<IReadOnlyList<UserInfo>> GetAllAsync(CancellationToken ct = default)
        => Task.FromResult<IReadOnlyList<UserInfo>>(_users.Values.ToList());

    public Task<UserInfo?> GetByIdAsync(string userId, CancellationToken ct = default)
        => Task.FromResult(_users.GetValueOrDefault(userId));

    // V1 config-based users have no email — always returns null.
    public Task<UserInfo?> GetByEmailAsync(string email, CancellationToken ct = default)
        => Task.FromResult<UserInfo?>(null);

    public Task<bool> ExistsAsync(string userId, CancellationToken ct = default)
        => Task.FromResult(_users.ContainsKey(userId));

    private sealed class UserConfig
    {
        public string Id               { get; set; } = string.Empty;
        public string DisplayName      { get; set; } = string.Empty;
        public string DefaultVaultPath { get; set; } = string.Empty;
    }
}
