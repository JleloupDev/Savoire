// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// Tests bUnit — Composants Blazor client

using Bunit;
using FluentAssertions;
using Microsoft.AspNetCore.Components;
using Microsoft.Extensions.DependencyInjection;
using NSubstitute;
using Xunit;

namespace Savoire.Client.Unit.Tests.Components;

// ── Interfaces client requises pour la testabilité ────────────────────────────
// Ces interfaces doivent être définies dans le projet client (V2).
// Pour l'instant : déclarées ici pour que les tests compilent.

public interface ISyncClient
{
    Task<VaultStub[]> GetVaultsAsync(string userId);
    Task<DocumentStub> CreateDocumentAsync(string vaultId, CreateDocStub req);
}

public interface IVaultManager
{
    Task<string> CloneVaultAsync(string vaultId, string localPath);
    Task SyncAsync();
}

// ── DTOs stub (remplacés par les vrais DTOs en V2) ──────────────────────────

public record VaultStub(string Id, string Name, string Role);
public record DocumentStub(string Id, string Path, string? Title);
public record CreateDocStub(string Path, string? Content);

// ── Composants stub (remplacés par les vrais composants en V2) ───────────────

// Simule le composant SyncStatus de l'éditeur
public class SyncStatusComponent : ComponentBase
{
    [Parameter] public string Status { get; set; } = "online";

    protected override void BuildRenderTree(
        Microsoft.AspNetCore.Components.Rendering.RenderTreeBuilder builder)
    {
        builder.OpenElement(0, "span");
        builder.AddAttribute(1, "data-status", Status);
        builder.AddContent(2, Status == "online" ? "En ligne" : "Hors ligne");
        builder.CloseElement();
    }
}

// ── Tests ────────────────────────────────────────────────────────────────────

public class EditorComponentTests : TestContext
{
    [Fact]
    public void SyncStatus_Online_ShowsOnlineLabel()
    {
        // Act
        var cut = RenderComponent<SyncStatusComponent>(
            p => p.Add(c => c.Status, "online"));

        // Assert
        cut.Find("[data-status='online']").TextContent
            .Should().Be("En ligne");
    }

    [Fact]
    public void SyncStatus_Offline_ShowsOfflineLabel()
    {
        // Act
        var cut = RenderComponent<SyncStatusComponent>(
            p => p.Add(c => c.Status, "offline"));

        // Assert
        cut.Find("[data-status='offline']").TextContent
            .Should().Be("Hors ligne");
    }

    [Fact(Skip = "VaultListComponent non extrait en RCL — V2")]
    public void VaultList_ShowsEmptyState_WhenNoVaults()
    {
        // Quand ISyncClient.GetVaultsAsync retourne [], afficher "Aucun vault"
    }

    [Fact(Skip = "VaultListComponent non extrait en RCL — V2")]
    public void VaultList_RendersAllVaults()
    {
        // Quand ISyncClient.GetVaultsAsync retourne N vaults,
        // le composant doit rendre N éléments
    }

    [Fact(Skip = "EditorComponent non extrait en RCL — V2")]
    public void Editor_ShowsConflictBanner_WhenConflict()
    {
        // Quand SyncService émet SyncConflict, afficher une bannière
    }
}
