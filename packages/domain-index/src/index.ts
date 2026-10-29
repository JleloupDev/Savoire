// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
export type { CrdtVersion } from './CrdtVersion'
export type { FileTreeEntry } from './FileTreeEntry'
export type { DocMetadata } from './DocMetadata'
export type { RelPosJSON } from './AnchorHandle'
export { anchorKey } from './AnchorHandle'
export type { ICollaborativeText } from './ICollaborativeText'
export type { IndexEntry } from './IndexEntry'
export { AnchorIndex, resolveEntry, validateEntry } from './AnchorIndex'
export type { IndexContributor, LocalIndexContributor, AnchorContributor, AnyIndexContributor, SharedIndexEntry } from './IndexContributor'
export { isSharedContributor } from './IndexContributor'
export { IndexEngine } from './IndexEngine'
export type { FrontmatterValue, FrontmatterBlock } from './frontmatter'
export { findFrontmatter, stripFrontmatter, parseFrontmatter, parseFrontmatterYaml, parseScalar } from './frontmatter'
export {
  setFrontmatterValue, removeFrontmatterKey, renameFrontmatterKey, frontmatterKeys,
  formatYamlScalar, formatYamlKey, minimalTextChange,
} from './frontmatterEdit'
