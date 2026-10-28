// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// Reponses de l'API interne lue par le pair indexeur
// (docs/Architecture/indexer-protocol.md, « API interne »).

using System.Text.Json.Serialization;

namespace Savoire.Application.Indexer.Internal;

public sealed record IndexerVaultDto(string VaultId, string Name);

public sealed record IndexerVaultListDto(IReadOnlyList<IndexerVaultDto> Vaults);

public sealed record IndexerChangeDto(
    long Seq,
    string VaultId,
    string Kind,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? DocId);

/// <summary>
/// Last : plus grande sequence examinee (le pair repart de la, meme si aucune
/// ligne ne le concerne). Epoch : identifiant de la base ; s'il change, le
/// pair repart de zero.
/// </summary>
public sealed record IndexerChangesDto(IReadOnlyList<IndexerChangeDto> Changes, long Last, string Epoch);

/// <summary>
/// Journal d'une ressource, en base64. Format : « yjs » (mises a jour Yjs a
/// rejouer dans un Y.Doc) ou « json » (document « snapshot » d'une room :
/// une seule entree, le JSON UTF-8 de son dernier etat).
/// </summary>
public sealed record IndexerUpdatesDto(IReadOnlyList<string> Updates, string Format);

public static class IndexerUpdateFormats
{
    public const string Yjs  = "yjs";
    public const string Json = "json";
}
