// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// Erreurs de l'API : toujours { error: { code, message } }.
namespace SavoireStore.Api;

public static class Errors
{
    public static IResult Of(int status, string code, string message) =>
        Results.Json(new { error = new { code, message } }, statusCode: status);

    public static IResult NotFound(string message) => Of(404, "not_found", message);
    public static IResult BadRequest(string message) => Of(400, "invalid", message);
    public static IResult Forbidden(string message) => Of(403, "forbidden", message);
}
