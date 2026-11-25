// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
export type {
  PluginManifest,
  PluginPermission,
  PluginScope,
  VaultPlugin,
  IPluginAPI,
  IPluginVaultAPI,
  IPluginWorkspaceAPI,
  IPluginCommandsAPI,
  IPluginViewsAPI,
  IPluginBlocksAPI,
  IPluginHooksAPI,
  IPluginSlashAPI,
  IPluginTriggersAPI,
  IPluginEditorAPI,
  IPluginToolbarAPI,
  PluginAPI,
  PluginCommandContext,
  PluginCommand,
  CommandRegistry,
  Hotkey,
  HotkeyModifier,
  HotkeyAPI,
  HotkeyEvent,
  HotkeyHost,
  HookStage,
  HookRegistry,
  StabilizedInfo,
  BlockWidget,
  BlockContext,
  BlockEditContext,
  BlockEnterDetail,
  BlockMenuItem,
  EditorMode,
  BlockSpec,
  BlockLine,
  BlockLineMarker,
  BlockRegistry,
  FileContext,
  FileView,
  FileTypeSpec,
  FileTypeRegistry,
  VaultAPI,
  ViewDocument,
  WorkspaceAPI,
  NotificationType,
  BlockTrigger,
  SlashCommandItem,
  SlashRegistry,
  InputTrigger,
  TriggerRegistry,
  TriggerItem,
  TriggerActivation,
  TriggerHandler,
  EditorPositionAPI,
  EditorCommandContext,
  ToolbarCommand,
  ToolbarCommandRegistry,
  Widget,
  ViewContext,
  ViewSpec,
  ViewGroup,
  MobilePlacement,
  ViewRegistry,
  DocumentRoom,
  DocumentRoomPresence,
  SyncAPI,
  PluginLoadStrategy,
  NotePluginScope,
  NoteScope,
  ContentExtractor,
  IndexContributor,
  AnyIndexContributor,
  LocalIndexContributor,
  AnchorContributor,
  SharedIndexEntry,
  ICollaborativeText,
  IndexEntry,
  RelPosJSON,
  IPluginIndexAPI,
  IIndexContributorRegistry,
  IIndexRegistry,
  IEditorHostAPI,
  IPluginLoader,
  CrdtVersion,
  DocMetadata,
  FileTreeEntry,
} from './types'
export { pluginTrust, trustAllowed } from './manifest'
export type { PluginTrust, PeerPluginPolicy } from './manifest'

// Runtime values from domain-index re-exported via indexing.ts
export { AnchorIndex, resolveEntry, validateEntry, anchorKey } from './indexing'

export type { ICRDT, AgentPeer, AgentPresenceInput, AiChangeInfo, AiChangeRanges, AiChangeWho, AiChangeMetaInput, AiChangeRecording } from './crdt'
export type { ITransport } from './transport'
export type { IIdentityProvider, ISeedExportingIdentityProvider } from './identity'
export { encodeSignedOp, decodeSignedOp, toHex, fromHex } from './identity'
export * from './indexChannel'
export * from './agents'
export * from './tools'
export { changeNoteText, minimalChange, noteRef } from './agentText'
export type * from './sharedMap'
export type * from './sharedText'
export type * from './sharedTree'
export type { TrashEntry, AttachmentUploadOptions } from './vault'
export type * from './properties'
export type * from './query'
export type * from './search'
export type * from './indexer'
export type { IconAPI, IconOptions } from './icons'
export { createIcon } from './icons'
export {
  QUERY_DEFAULT_LIMIT, QUERY_MAX_LIMIT, QUERY_MAX_AGGREGATES,
  BASE_ROW_PREFIX, BASE_ROW_TITLE, BASE_LOT_COUNT, baseLotName, baseLotOf,
} from './query'
export {
  PROPERTY_TYPES, PROPERTY_TYPE_INFO, guessPropertyType, coercePropertyValue, propertyTypeOf,
  STATUS_GROUPS, DEFAULT_STATUS_OPTIONS, NUMBER_FORMATS, formatNumber, AUTO_PROPERTY_TYPES, isListType, splitDateRange,
  parseFrontmatter, findFrontmatter, setFrontmatterValue, removeFrontmatterKey,
  renameFrontmatterKey, frontmatterKeys, minimalTextChange,
} from './properties'
export type { CompiledFormula, FormulaResult, FormulaRow, FormulaAggregateCall } from './formula'
export {
  compileFormula, tryCompileFormula, FormulaError, FORMULA_FUNCTIONS, FORMULA_MAX_LENGTH, aggregateKey,
} from './formula'
export { BLOCK_DESTROY_EVENT, BLOCK_ENTER_EVENT } from './blocks'
export type { LinkResolver } from './links'
export { resolveLinkPath, createLinkResolver, linkTargetFor, fileExtensionOf, withNoteExtension, noteName, rewriteMovedLinks, linkedPathsOf } from './links'
export type { LinkMoveContext } from './links'
export { relinkAfterMoves, moveWithLinks } from './relink'
export type { Move, RelinkVault, CitingLookup } from './relink'
export { TEMPLATE_FOLDERS, formatDate, renderTemplate, noteTitleOf, templateFolderOf } from './templates'
export type { TemplateContext } from './templates'
export {
  QUERY_MAX_FORMULAS, QueryEvalError, FieldReader, foldText, isEmptyValue, isFormulaField, queryUsesFormula,
  splitFormulaFilter, compareScalar, matchesDoc, sortDocs, groupDocs, checkAggregates, aggregateDocs,
} from './queryEval'
export type { EvalDoc } from './queryEval'
export * from './libraries'
export * from './ai'
export * from './network'
export * from './archive'
export * from './extractors'
export * from './xml'
export * from './documentPreview'
export { sanitizeHtml, setSanitizedHtml, sanitizerKind } from './sanitize'
export * from './review'
export {
  SAVOIRE_CAPABILITIES, capabilityInfo, isCapabilityId, analyzeCapabilities, overclaimedCapabilities, emptyRegistrations,
} from './capabilities'
export type {
  CapabilityId, CapabilityLevel, CapabilityInfo, CapabilityReport, PluginRegistrations, DiffItem, FileTypeReview,
  ComparableView, ComparableFileView,
} from './capabilities'
export { SLIDE_THEMES, SLIDE_TRANSITIONS, SLIDE_EFFECTS, SLIDE_DECORS, isSlidesNote, slideDeck, slideSeparators, slideIndexAt, slideSteps, insertIntoSlide, setDeckStyle, setSlideStyle, setSlideImage, slideStyleValue } from './slides'
export { REMOTE_NOTES_MAX, isRemoteMessage, newRemoteSession, remoteUrl, isLocalOrigin } from './slideRemote'
export type { SlideScreenState, SlideRemoteCommand, SlideRemoteOrder, SlideRemoteMessage, SlideRemoteLink } from './slideRemote'
export type { Slide, SlideDeck, SlideTheme, SlideRatio, SlideTransition, SlideEffect, SlideDecor, SlideImage, SlideOptions, DeckStyle, SlideStyle } from './slides'
export type { NoteBlock, NoteBlockKind } from './noteBlocks'
export { splitNoteBlocks, blockFingerprint, textFingerprint, blockAt, newBlockId, blockIdInsertion, PROSE_BLOCK_KINDS } from './noteBlocks'
