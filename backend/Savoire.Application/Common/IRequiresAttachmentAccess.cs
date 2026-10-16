// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
namespace Savoire.Application.Common;

/// <summary>
/// Requete sur UNE piece jointe. Pour un compte, rien ne change : le droit
/// sur le vault suffit (<see cref="IRequiresVaultAccess"/>). Pour un lien de
/// partage limite a une note, la lecture est aussi permise quand la piece
/// jointe est rangee dans le dossier de cette note (registre vault_documents).
/// </summary>
public interface IRequiresAttachmentAccess : IRequiresVaultAccess
{
    /// <summary>Identifiant de stockage de la piece jointe (celui de son document).</summary>
    string AttachmentId { get; }
}
