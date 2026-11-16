// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
namespace Savoire.Domain.ReadModels;

/// <summary>
/// Un retour envoye depuis l'application (la bulle en bas a droite) : ce que
/// la personne aimerait changer, une capture de l'ecran si elle l'a gardee,
/// et le contexte technique (page, navigateur, taille d'ecran...).
/// Lu par l'administrateur, seul ou avec l'IA.
/// </summary>
public sealed record FeedbackReport(
    string Id,
    string UserId,
    string Message,
    // Contexte relevé par l'appli, en JSON (objet plat). Jamais interprete ici.
    string ContextJson,
    // En-tete User-Agent de l'envoi, tel que recu.
    string? UserAgent,
    // Capture (PNG ou JPEG) ; null : envoyee sans capture.
    byte[]? Screenshot,
    string? ScreenshotType,
    DateTime CreatedAt,
    // Traite par l'administrateur : sort de la liste et de l'analyse.
    DateTime? ArchivedAt);

/// <summary>Un retour sans sa capture : pour la liste et pour l'analyse.</summary>
public sealed record FeedbackReportSummary(
    string Id, string UserId, string Message, string ContextJson, string? UserAgent,
    bool HasScreenshot, DateTime CreatedAt, DateTime? ArchivedAt);
