// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Icones de l'appli : la famille Lucide (licence ISC), celle d'Obsidian.
// On appelle une icone par son nom Lucide (« bold », « trash-2 ») : un plugin
// ecrit pour Obsidian obtient la meme icone avec le meme nom.
//
//  - Les noms courants sont dans le bundle principal (ICONS ci-dessous).
//  - Un autre nom Lucide valide charge le jeu complet a part, une fois, au
//    premier besoin : il n'alourdit pas le demarrage.
//  - Un texte qui n'est pas un nom (emoji, « H1 ») s'affiche tel quel : les
//    anciens plugins continuent de marcher.
/// <reference path="./lucide-all.d.ts" />

import { useEffect, useState, type CSSProperties } from 'react'
import {
  Bold, Italic, Strikethrough, Code, Highlighter, Baseline, List, ListOrdered,
  ListChecks, TextQuote, SquareCode, Table, Link, Image, Minus, FileDown,
  Heading, Heading1, Heading2, Heading3, Heading4, Heading5, Heading6, Pilcrow,
  ChevronDown, ChevronRight, ChevronLeft, ChevronUp, Ellipsis, Plus, X, Check,
  Ban, Info, Lightbulb, CircleCheck, TriangleAlert, Flame, Bug, CircleHelp,
  MessageSquare, MessageSquarePlus, MessageCircle, File, FileText, Files, FilePlus, FileImage,
  FileSpreadsheet, FileSearch, Folder, FolderOpen, FolderPlus, Trash2, RefreshCw, Search,
  History, GitFork, Hash, Tag, PanelRight, Cpu, Calendar, CalendarDays,
  Settings, Pencil, Copy, Download, Upload, ExternalLink, Eye, EyeOff,
  Lock, LockOpen, User, Users, Bot, Sparkles, Puzzle, LayoutTemplate,
  Brain, Workflow, Network, Shapes, Database, BookOpen, StickyNote, Presentation,
  Sheet, Frame, ListTree, Link2, Brackets, SquareCheck, CircleDot, Text,
  PenTool, Smile, ClipboardList, Kanban, Columns3, Star, Pin, ArrowUp,
  ArrowDown, ArrowLeft, ArrowRight, RotateCcw, Undo2, Redo2, LogOut, LogIn,
  Share2, Globe, Cloud, CloudOff, WifiOff, CircleAlert, CircleX, Maximize2,
  Minimize2, GripVertical, Move, Filter, SlidersHorizontal, Type, Quote,
  Square, Zap, NotebookText, LayoutDashboard, FileCode, MessagesSquare, FileInput, CircleCheckBig, BookOpenText, ImagePlus,
  type LucideIcon,
} from 'lucide-react'

export const ICONS: Readonly<Record<string, LucideIcon>> = {
  'bold': Bold,
  'italic': Italic,
  'strikethrough': Strikethrough,
  'code': Code,
  'highlighter': Highlighter,
  'baseline': Baseline,
  'list': List,
  'list-ordered': ListOrdered,
  'list-checks': ListChecks,
  'text-quote': TextQuote,
  'square-code': SquareCode,
  'table': Table,
  'link': Link,
  'image': Image,
  'minus': Minus,
  'file-down': FileDown,
  'heading': Heading,
  'heading-1': Heading1,
  'heading-2': Heading2,
  'heading-3': Heading3,
  'heading-4': Heading4,
  'heading-5': Heading5,
  'heading-6': Heading6,
  'pilcrow': Pilcrow,
  'chevron-down': ChevronDown,
  'chevron-right': ChevronRight,
  'chevron-left': ChevronLeft,
  'chevron-up': ChevronUp,
  'ellipsis': Ellipsis,
  'plus': Plus,
  'x': X,
  'check': Check,
  'ban': Ban,
  'info': Info,
  'lightbulb': Lightbulb,
  'circle-check': CircleCheck,
  'triangle-alert': TriangleAlert,
  'flame': Flame,
  'bug': Bug,
  'circle-help': CircleHelp,
  'message-square': MessageSquare,
  'message-square-plus': MessageSquarePlus,
  'message-circle': MessageCircle,
  'file': File,
  'file-text': FileText,
  'files': Files,
  'file-plus': FilePlus,
  'file-image': FileImage,
  'file-spreadsheet': FileSpreadsheet,
  'file-search': FileSearch,
  'folder': Folder,
  'folder-open': FolderOpen,
  'folder-plus': FolderPlus,
  'trash-2': Trash2,
  'refresh-cw': RefreshCw,
  'search': Search,
  'history': History,
  'git-fork': GitFork,
  'hash': Hash,
  'tag': Tag,
  'panel-right': PanelRight,
  'cpu': Cpu,
  'calendar': Calendar,
  'calendar-days': CalendarDays,
  'settings': Settings,
  'pencil': Pencil,
  'copy': Copy,
  'download': Download,
  'upload': Upload,
  'external-link': ExternalLink,
  'eye': Eye,
  'eye-off': EyeOff,
  'lock': Lock,
  'lock-open': LockOpen,
  'user': User,
  'users': Users,
  'bot': Bot,
  'sparkles': Sparkles,
  'puzzle': Puzzle,
  'layout-template': LayoutTemplate,
  'brain': Brain,
  'workflow': Workflow,
  'network': Network,
  'shapes': Shapes,
  'database': Database,
  'book-open': BookOpen,
  'sticky-note': StickyNote,
  'presentation': Presentation,
  'sheet': Sheet,
  'frame': Frame,
  'list-tree': ListTree,
  'link-2': Link2,
  'brackets': Brackets,
  'square-check': SquareCheck,
  'circle-dot': CircleDot,
  'text': Text,
  'pen-tool': PenTool,
  'smile': Smile,
  'clipboard-list': ClipboardList,
  'kanban': Kanban,
  'columns-3': Columns3,
  'star': Star,
  'pin': Pin,
  'arrow-up': ArrowUp,
  'arrow-down': ArrowDown,
  'arrow-left': ArrowLeft,
  'arrow-right': ArrowRight,
  'rotate-ccw': RotateCcw,
  'undo-2': Undo2,
  'redo-2': Redo2,
  'log-out': LogOut,
  'log-in': LogIn,
  'share-2': Share2,
  'globe': Globe,
  'cloud': Cloud,
  'cloud-off': CloudOff,
  'wifi-off': WifiOff,
  'circle-alert': CircleAlert,
  'circle-x': CircleX,
  'maximize-2': Maximize2,
  'minimize-2': Minimize2,
  'grip-vertical': GripVertical,
  'move': Move,
  'filter': Filter,
  'sliders-horizontal': SlidersHorizontal,
  'type': Type,
  'quote': Quote,
  'square': Square,
  'zap': Zap,
  'notebook-text': NotebookText,
  'layout-dashboard': LayoutDashboard,
  'file-code': FileCode,
  'messages-square': MessagesSquare,
  'file-input': FileInput,
  'circle-check-big': CircleCheckBig,
  'book-open-text': BookOpenText,
  'image-plus': ImagePlus,
}

/** Anciens noms internes, remplaces par leur nom Lucide. */
const ALIASES: Readonly<Record<string, string>> = {
  'layout-panel-right': 'panel-right',
  'quick-open': 'file-search',
}

/** Un nom d'icone Lucide : minuscules, chiffres et tirets (« list-checks »). */
export function isIconName(value: string | undefined | null): value is string {
  return !!value && /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(value)
}

type AllIcons = Record<string, LucideIcon>
let all: AllIcons | null = null
let loading: Promise<AllIcons> | null = null
function loadAll(): Promise<AllIcons> {
  loading ??= import('lucide-react/dist/esm/icons/index.mjs').then(m => (all = m as unknown as AllIcons))
  return loading
}

function pascal(name: string): string {
  return name.replace(/(^|-)([a-z0-9])/g, (_, __, c: string) => c.toUpperCase())
}

function resolve(name: string): LucideIcon | undefined {
  const n = ALIASES[name] ?? name
  return ICONS[n] ?? all?.[pascal(n)]
}

export interface IconProps {
  /** Nom Lucide, ou texte affiche tel quel (emoji, « H1 »). */
  name?: string | null
  /** Taille en px (16 par defaut). */
  size?: number
  strokeWidth?: number
  className?: string
  style?: CSSProperties
  /** Texte lu par les lecteurs d'ecran ; sans lui l'icone est decorative. */
  label?: string
}

export function Icon({ name, size = 16, strokeWidth = 1.75, className, style, label }: IconProps) {
  const [, setLoaded] = useState(0)
  const known = isIconName(name) ? resolve(name) : undefined
  const missing = isIconName(name) && !known && !all
  useEffect(() => {
    if (!missing) return
    let alive = true
    void loadAll().then(() => { if (alive) setLoaded(n => n + 1) }, () => { /* hors ligne : on garde le repli */ })
    return () => { alive = false }
  }, [missing])

  const a11y = label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': true }
  if (known) {
    const Svg = known
    return <Svg size={size} strokeWidth={strokeWidth} className={className} style={{ flexShrink: 0, ...style }} {...a11y} />
  }
  if (!name || isIconName(name)) {
    // Nom inconnu (ou jeu complet pas encore la) : une place vide de la bonne
    // taille, pour que rien ne saute a l'arrivee de l'icone.
    return <span className={className} style={{ display: 'inline-block', width: size, height: size, flexShrink: 0, ...style }} {...a11y} />
  }
  return (
    <span
      className={className}
      style={{
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        minWidth: size, height: size, flexShrink: 0, lineHeight: 1,
        fontSize: Math.round(size * 0.8), fontWeight: 600, ...style,
      }}
      {...a11y}
    >
      {name}
    </span>
  )
}

// ── Hors React : un element DOM (plugins en DOM, api.icons) ─────────────────

type IconNode = Array<[string, Record<string, string | number>]>
const SVG_NS = 'http://www.w3.org/2000/svg'

/** Dessin d'une icone : lu sur le composant (forwardRef) sans le rendre. */
function nodeOf(Comp: LucideIcon): IconNode | null {
  try {
    const render = (Comp as unknown as { render?: (props: object, ref: null) => { props?: { icon?: { node?: IconNode } } } }).render
    return render?.({}, null)?.props?.icon?.node ?? null
  } catch { return null }
}

function drawInto(span: HTMLElement, Comp: LucideIcon, name: string, size: number, strokeWidth: number): boolean {
  const node = nodeOf(Comp)
  if (!node) return false
  const svg = document.createElementNS(SVG_NS, 'svg')
  const attrs: Record<string, string> = {
    xmlns: SVG_NS, width: String(size), height: String(size), viewBox: '0 0 24 24',
    fill: 'none', stroke: 'currentColor', 'stroke-width': String(strokeWidth),
    'stroke-linecap': 'round', 'stroke-linejoin': 'round', class: `lucide lucide-${name}`,
    'aria-hidden': 'true',
  }
  for (const [k, v] of Object.entries(attrs)) svg.setAttribute(k, v)
  for (const [tag, a] of node) {
    const child = document.createElementNS(SVG_NS, tag)
    for (const [k, v] of Object.entries(a)) if (k !== 'key') child.setAttribute(k, String(v))
    svg.appendChild(child)
  }
  span.replaceChildren(svg)
  return true
}

/**
 * Icone en element DOM : un <span> qui contient le SVG. Nom inconnu du
 * bundle : le span garde sa place et se remplit quand le jeu complet arrive.
 * Texte (emoji) : affiche tel quel.
 */
export function createIconElement(name: string, options: { size?: number; className?: string; label?: string; strokeWidth?: number } = {}): HTMLElement {
  const { size = 16, className, label, strokeWidth = 1.75 } = options
  const span = document.createElement('span')
  span.className = className ? `sv-icon ${className}` : 'sv-icon'
  span.style.cssText = `display:inline-flex;align-items:center;justify-content:center;flex-shrink:0;min-width:${size}px;height:${size}px;line-height:1`
  if (label) { span.setAttribute('role', 'img'); span.setAttribute('aria-label', label) } else span.setAttribute('aria-hidden', 'true')
  if (!isIconName(name)) {
    span.textContent = name
    span.style.fontSize = `${Math.round(size * 0.8)}px`
    return span
  }
  const known = resolve(name)
  if (known && drawInto(span, known, ALIASES[name] ?? name, size, strokeWidth)) return span
  if (!all) {
    void loadAll().then(() => {
      const late = resolve(name)
      if (late) drawInto(span, late, ALIASES[name] ?? name, size, strokeWidth)
    }, () => { /* hors ligne : la place reste vide */ })
  }
  return span
}
