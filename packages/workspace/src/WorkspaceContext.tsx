// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import { createContext, useContext } from 'react'
import type { WorkspaceManagerImpl } from './WorkspaceManagerImpl'


export const WorkspaceContext = createContext<WorkspaceManagerImpl | null>(null)

export function useWorkspace(): WorkspaceManagerImpl {
  const ctx = useContext(WorkspaceContext)
  if (!ctx) throw new Error('useWorkspace must be used inside <WorkspaceRoot>')
  return ctx
}
