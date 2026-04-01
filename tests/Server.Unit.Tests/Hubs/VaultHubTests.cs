// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// Tests unitaires — VaultHub (version MediatR)
// Le hub délègue à IMediator. Les broadcasts sont déclenchés par les
// INotificationHandler (hors scope de ces tests unitaires).
// see ADR-001

using System.Security.Claims;
using FluentAssertions;
using MediatR;
using Microsoft.AspNetCore.SignalR;
using Microsoft.Extensions.Logging;
using NSubstitute;
using Savoire.Application.Common;
using Savoire.Application.Documents.CreateDocument;
using Savoire.Application.Documents.DeleteDocument;
using Savoire.Application.Documents.ListDocuments;
using Savoire.Application.Documents.RenameDocument;
// MediatR.Unit not needed — DeleteDocumentCommand returns void (IRequest)
using Savoire.Application.Sync.Common;
using Savoire.Server.Hubs;

namespace Savoire.Server.Unit.Tests.Hubs;

public class VaultHubTests
{
    private const string VaultId      = "vault-unit";
    private const string UserId       = "user-unit";
    private const string ConnectionId = "conn-unit-test";

    private readonly IMediator          _mediator;
    private readonly IHubCallerClients  _clients;
    private readonly ISingleClientProxy _callerProxy;
    private readonly IGroupManager      _groups;
    private readonly VaultHub           _hub;

    public VaultHubTests()
    {
        _mediator    = Substitute.For<IMediator>();
        _clients     = Substitute.For<IHubCallerClients>();
        _callerProxy = Substitute.For<ISingleClientProxy>();
        _groups      = Substitute.For<IGroupManager>();

        _clients.Caller.Returns(_callerProxy);

        var context = Substitute.For<HubCallerContext>();
        context.ConnectionId.Returns(ConnectionId);

        // Simule un utilisateur authentifié avec claim "sub"
        var identity = new ClaimsIdentity(
            [new Claim("sub", UserId)], "Bearer");
        context.User.Returns(new ClaimsPrincipal(identity));

        _hub = new VaultHub(_mediator, Substitute.For<ILogger<VaultHub>>(), new IndexOpSequencer())
        {
            Clients = _clients,
            Groups  = _groups,
            Context = context
        };
    }

    // ── JoinVault ─────────────────────────────────────────────────────────────

    [Fact]
    public async Task JoinVault_AddsConnectionToGroup_SendsVaultSnapshot()
    {
        // Arrange
        var docs = new List<DocumentDto>
        {
            new("doc-1", "notes.md", "Notes", "", 0, DateTime.UtcNow, DateTime.UtcNow)
        };
        _mediator.Send(Arg.Any<ListDocumentsQuery>(), Arg.Any<CancellationToken>())
                 .Returns(docs);

        // Act
        await _hub.JoinVault(VaultId);

        // Assert — groupe rejoint
        await _groups.Received(1)
            .AddToGroupAsync(ConnectionId, VaultId, Arg.Any<CancellationToken>());

        // Assert — query correcte envoyée à MediatR
        await _mediator.Received(1).Send(
            Arg.Is<ListDocumentsQuery>(q => q.VaultId == VaultId && q.CallerId == UserId),
            Arg.Any<CancellationToken>());

        // Assert — snapshot envoyé au caller
        await _callerProxy.Received(1).SendCoreAsync(
            "VaultSnapshot",
            Arg.Any<object?[]>(),
            Arg.Any<CancellationToken>());
    }

    [Fact]
    public async Task JoinVault_EmptyVault_SendsEmptySnapshot()
    {
        _mediator.Send(Arg.Any<ListDocumentsQuery>(), Arg.Any<CancellationToken>())
                 .Returns(new List<DocumentDto>());

        await _hub.JoinVault(VaultId);

        await _callerProxy.Received(1).SendCoreAsync(
            "VaultSnapshot",
            Arg.Any<object?[]>(),
            Arg.Any<CancellationToken>());
    }

    // ── CreateDocument ────────────────────────────────────────────────────────

    [Fact]
    public async Task CreateDocument_SendsCreateDocumentCommand_ReturnsSnapshotItem()
    {
        // Arrange
        var dto = new DocumentDto("doc-1", "ideas/spark.md", null, "", 0, DateTime.UtcNow, DateTime.UtcNow);
        _mediator.Send(Arg.Any<CreateDocumentCommand>(), Arg.Any<CancellationToken>())
                 .Returns(dto);

        // Act
        var result = await _hub.CreateDocument(VaultId, "ideas/spark.md", null);

        // Assert — commande correcte envoyée
        await _mediator.Received(1).Send(
            Arg.Is<CreateDocumentCommand>(c =>
                c.CallerId == UserId &&
                c.VaultId  == VaultId &&
                c.Path     == "ideas/spark.md"),
            Arg.Any<CancellationToken>());

        // Assert — résultat mappé correctement
        result.Id.Should().Be("doc-1");
        result.Path.Should().Be("ideas/spark.md");
    }

    // ── RenameDocument ────────────────────────────────────────────────────────

    [Fact]
    public async Task RenameDocument_SendsRenameDocumentCommand()
    {
        var dto = new DocumentDto("doc-1", "new-name.md", null, "", 0, DateTime.UtcNow, DateTime.UtcNow);
        _mediator.Send(Arg.Any<RenameDocumentCommand>(), Arg.Any<CancellationToken>())
                 .Returns(dto);

        await _hub.RenameDocument("doc-1", "new-name.md");

        await _mediator.Received(1).Send(
            Arg.Is<RenameDocumentCommand>(c =>
                c.CallerId == UserId &&
                c.DocId    == "doc-1" &&
                c.NewPath  == "new-name.md" &&
                c.VaultId  == "__resolve__"),
            Arg.Any<CancellationToken>());
    }

    // ── DeleteDocument ────────────────────────────────────────────────────────

    [Fact]
    public async Task DeleteDocument_SendsDeleteDocumentCommand()
    {
        // DeleteDocumentCommand : IRequest (returns MediatR.Unit) — pas de valeur de retour à mocker
        await _hub.DeleteDocument("doc-1");

        await _mediator.Received(1).Send(
            Arg.Is<DeleteDocumentCommand>(c =>
                c.CallerId == UserId &&
                c.DocId    == "doc-1" &&
                c.VaultId  == "__resolve__"),
            Arg.Any<CancellationToken>());
    }
}
