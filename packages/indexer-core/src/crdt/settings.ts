// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Types des proprietes du vault, lus dans son canal de reglages
// « settings/properties » (une carte Yjs `entries` : propriete ->
// { type, label?, options? }), comme VaultPropertyTypes cote clients. Le pair
// s'en sert pour typer les valeurs a l'identique des clients.
import { PROPERTY_TYPES } from '@savoire/plugin-api'
import type { PropertyDef, PropertySchema, PropertyType } from '@savoire/plugin-api'
import type * as Y from 'yjs'
import { withDoc } from './yjs'
import type { YjsUpdate } from './yjs'

/** Namespace du canal des types (session.openVaultSettings('properties')). */
export const PROPERTY_TYPES_NAMESPACE = 'settings/properties'

export function readPropertySchema(doc: Y.Doc): PropertySchema {
  const map = doc.getMap('entries')
  const properties: PropertyDef[] = []
  map.forEach((value, key) => {
    const v = value as { type?: unknown } | null
    if (!v || typeof v !== 'object' || !PROPERTY_TYPES.includes(v.type as PropertyType)) return
    properties.push({ key, type: v.type as PropertyType })
  })
  properties.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
  return { properties }
}

export function propertySchemaFromUpdates(updates: readonly YjsUpdate[]): PropertySchema {
  return withDoc(updates, readPropertySchema)
}

/** Empreinte stable : deux schemas egaux, meme texte. Vide : ''. */
export function propertySchemaKey(schema: PropertySchema | undefined): string {
  if (!schema?.properties.length) return ''
  return JSON.stringify([...schema.properties].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)).map(d => [d.key, d.type]))
}
