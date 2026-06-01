// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
using System.Security.Claims;
using FluentAssertions;
using MediatR;
using Microsoft.AspNetCore.SignalR;
using Microsoft.Extensions.Logging;
using NSubstitute;
using Savoire.Application.Common;
using Savoire.Application.Documents.CreateDocument;
using Savoire.Application.Documents.DeleteDocument;
using Savoire.Application.Documents.RenameDocument;
using Savoire.Application.Sync.Common;
using Savoire.Application.Sync.JoinVault;
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

        var identity = new ClaimsIdentity([new Claim("sub", UserId)], "Bearer");
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
    public async Task JoinVault_AddsConnectionToGroup_SendsInitVault()
    {
        _mediator.Send(Arg.Any<JoinVaultQuery>(), Arg.Any<CancellationToken>())
                 .Returns(new JoinVaultResult([]));

        await _hub.JoinVault(VaultId);

        await _groups.Received(1)
            .AddToGroupAsync(ConnectionId, VaultId, Arg.Any<CancellationToken>());

        await _mediator.Received(1).Send(
            Arg.Is<JoinVaultQuery>(q => q.VaultId == VaultId && q.CallerId == UserId),
            Arg.Any<CancellationToken>());

        await _callerProxy.Received(1).SendCoreAsync(
            "InitVault",
            Arg.Any<object?[]>(),
            Arg.Any<CancellationToken>());
    }

    [Fact]
    public async Task JoinVault_EmptyVault_SendsInitVaultWithEmptyOps()
    {
        _mediator.Send(Arg.Any<JoinVaultQuery>(), Arg.Any<CancellationToken>())
                 .Returns(new JoinVaultResult([]));

        object?[]? capturedArgs = null;
        await _callerProxy.SendCoreAsync(
            Arg.Any<string>(), Arg.Do<object?[]>(a => capturedArgs = a), Arg.Any<CancellationToken>());

        await _hub.JoinVault(VaultId);

        capturedArgs.Should().NotBeNull();
        capturedArgs![0].Should().Be(VaultId);
        ((string[])capturedArgs[1]!).Should().BeEmpty();
    }

    [Fact]
    public async Task JoinVault_WithExistingOps_SendsThemAll()
    {
        var ops = new[] { Convert.ToBase64String([1, 2, 3]), Convert.ToBase64String([4, 5, 6]) };
        _mediator.Send(Arg.Any<JoinVaultQuery>(), Arg.Any<CancellationToken>())
                 .Returns(new JoinVaultResult(ops));

        object?[]? capturedArgs = null;
        await _callerProxy.SendCoreAsync(
            Arg.Any<string>(), Arg.Do<object?[]>(a => capturedArgs = a), Arg.Any<CancellationToken>());

        await _hub.JoinVault(VaultId);

        ((string[])capturedArgs![1]!).Should().HaveCount(2);
    }

    // ── CreateDocument ────────────────────────────────────────────────────────

    [Fact]
    public async Task CreateDocument_SendsCreateDocumentCommand_ReturnsVaultDocumentItem()
    {
        var dto = new DocumentDto("doc-1", "ideas/spark.md", null, "", 0, DateTime.UtcNow, DateTime.UtcNow);
        _mediator.Send(Arg.Any<CreateDocumentCommand>(), Arg.Any<CancellationToken>())
                 .Returns(dto);

        var result = await _hub.CreateDocument(VaultId, "ideas/spark.md", null);

        await _mediator.Received(1).Send(
            Arg.Is<CreateDocumentCommand>(c =>
                c.CallerId == UserId &&
                c.VaultId  == VaultId &&
                c.Path     == "ideas/spark.md"),
            Arg.Any<CancellationToken>());

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
        await _hub.DeleteDocument("doc-1");

        await _mediator.Received(1).Send(
            Arg.Is<DeleteDocumentCommand>(c =>
                c.CallerId == UserId &&
                c.DocId    == "doc-1" &&
                c.VaultId  == "__resolve__"),
            Arg.Any<CancellationToken>());
    }
}
