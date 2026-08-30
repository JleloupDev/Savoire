// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
using System.Security.Claims;
using FluentAssertions;
using MediatR;
using Microsoft.AspNetCore.SignalR;
using Microsoft.Extensions.Logging;
using NSubstitute;
using Savoire.Application.Sync.Common;
using Savoire.Application.Sync.JoinVault;
using Savoire.Application.Sync.PushVaultOperation;
using Savoire.Application.Sync.SnapshotVault;
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

    // ── PushVaultOperation ────────────────────────────────────────────────────

    [Fact]
    public async Task PushVaultOperation_SendsCommand_AndRelaysToOthers()
    {
        var othersProxy = Substitute.For<IClientProxy>();
        _clients.OthersInGroup(VaultId).Returns(othersProxy);

        var op = Convert.ToBase64String([1, 2, 3]);
        await _hub.PushVaultOperation(VaultId, op);

        await _mediator.Received(1).Send(
            Arg.Is<PushVaultOperationCommand>(c => c.VaultId == VaultId),
            Arg.Any<CancellationToken>());

        await othersProxy.Received(1).SendCoreAsync(
            "VaultOperationReceived",
            Arg.Any<object?[]>(),
            Arg.Any<CancellationToken>());
    }

    [Fact]
    public async Task PushVaultOperation_InvalidBase64_DoesNotSendCommand()
    {
        await _hub.PushVaultOperation(VaultId, "!!!not-base64!!!");

        await _mediator.DidNotReceive().Send(
            Arg.Any<PushVaultOperationCommand>(), Arg.Any<CancellationToken>());
    }

    // ── SnapshotVault ─────────────────────────────────────────────────────────

    [Fact]
    public async Task SnapshotVault_SendsCommand()
    {
        var snapshot = Convert.ToBase64String([9, 9, 9]);
        await _hub.SnapshotVault(VaultId, snapshot);

        await _mediator.Received(1).Send(
            Arg.Is<SnapshotVaultCommand>(c => c.VaultId == VaultId),
            Arg.Any<CancellationToken>());
    }
}
