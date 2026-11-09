// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Les extracteurs fournis par les plugins (plugin-api/extractors.ts) : un
// registre pour toute l'application. L'index du bureau s'en sert pour lire
// les documents que Savoire n'edite pas ; les vues, pour leurs apercus.
import { ExtractorRegistryImpl } from '@savoire/plugin-runtime'

export const extractorRegistry = new ExtractorRegistryImpl()
