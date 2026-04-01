// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
namespace Savoire.Domain.Aggregates;

public sealed class Operation
{
    public string   Id         { get; private set; } = null!;
    public string   DocumentId { get; private set; } = null!;
    public string   ClientId   { get; private set; } = null!;
    public DateTime ProducedAt { get; private set; }
    public DateTime ReceivedAt { get; private set; }
    public byte[]   OpBytes    { get; private set; } = null!;

    private Operation() { }

    public static Operation Create(string documentId, string clientId,
                                    DateTime producedAt, byte[] opBytes) => new()
    {
        Id         = Guid.NewGuid().ToString(),
        DocumentId = documentId,
        ClientId   = clientId,
        ProducedAt = producedAt,
        ReceivedAt = DateTime.UtcNow,
        OpBytes    = opBytes
    };

    // FOR_PERSISTENCE_ONLY
    public static Operation Rehydrate(string id, string documentId, string clientId,
                                         DateTime producedAt, DateTime receivedAt, byte[] opBytes) =>
        new()
        {
            Id = id, DocumentId = documentId, ClientId = clientId,
            ProducedAt = producedAt, ReceivedAt = receivedAt, OpBytes = opBytes
        };
}
