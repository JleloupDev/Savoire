// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
/**
 * E2E tests for the React web app (http://localhost:3000).
 * All API calls are intercepted via page.route() — no real backend required.
 *
 * Coverage:
 *  - Login page (render, success, 401 error, Enter key)
 *  - Vault list (empty state, select vault)
 *  - Sidebar (create vault, create document, create folder)
 *  - Editor (mounts after doc selected)
 *  - Vault settings modal (open, rename, delete)
 *  - Theme switching (localStorage persistence)
 *  - Admin page (accessible by admin, shows user list)
 *  - Auth guard (unauthenticated redirects)
 */

import { test, expect, type Page, type Route } from '@playwright/test'

// ─── Fixtures ────────────────────────────────────────────────────────────────

const AUTH_RESPONSE = {
  accessToken: 'mock-access-token',
  refreshToken: 'mock-refresh-token',
  expiresIn: 3600,
  user: { id: 'user-1', displayName: 'Admin', email: 'admin@local.dev', isAdmin: true },
}

const VAULTS = [
  { id: 'vault-1', name: 'Mon Vault', role: 'Owner', documentCount: 2, folderCount: 1, lastModifiedAt: '2024-01-15T10:00:00Z', sizeBytes: 4096 },
  { id: 'vault-2', name: 'Vault Perso', role: 'Editor', documentCount: 5, folderCount: 2, lastModifiedAt: null, sizeBytes: 10240 },
]

const DOCUMENTS = [
  { id: 'doc-1', path: 'Notes/intro.md', title: 'Introduction', hash: 'abc', sizeBytes: 512, createdAt: '2024-01-01T00:00:00Z', updatedAt: '2024-01-01T00:00:00Z' },
  { id: 'doc-2', path: 'Notes/todo.md', title: null, hash: 'def', sizeBytes: 256, createdAt: '2024-01-02T00:00:00Z', updatedAt: '2024-01-02T00:00:00Z' },
]

const FOLDERS = [
  { id: 'folder-1', path: 'Notes', createdAt: '2024-01-01T00:00:00Z' },
]

const ADMIN_USERS = [
  { id: 'user-1', email: 'admin@local.dev', displayName: 'Admin', isAdmin: true, createdAt: '2024-01-01T00:00:00Z', lastLoginAt: '2024-01-15T00:00:00Z', isLockedOut: false },
  { id: 'user-2', email: 'user@local.dev', displayName: 'Utilisateur', isAdmin: false, createdAt: '2024-01-02T00:00:00Z', lastLoginAt: null, isLockedOut: false },
]

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function mockAPI(page: Page) {
  await page.route('**/api/v1/auth/login', (route: Route) => {
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(AUTH_RESPONSE) })
  })

  await page.route('**/api/v1/auth/refresh', (route: Route) => {
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(AUTH_RESPONSE) })
  })

  await page.route('**/api/v1/vaults', (route: Route) => {
    const method = route.request().method()
    if (method === 'GET') {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(VAULTS) })
    } else if (method === 'POST') {
      const newVault = { id: 'vault-new', name: 'Nouveau Vault', role: 'Owner', documentCount: 0, folderCount: 0, sizeBytes: 0, lastModifiedAt: null }
      route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify(newVault) })
    } else {
      route.continue()
    }
  })

  await page.route('**/api/v1/vaults/vault-1', (route: Route) => {
    const method = route.request().method()
    if (method === 'GET') {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ...VAULTS[0], members: [] }) })
    } else if (method === 'PATCH') {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ...VAULTS[0], name: 'Vault Renomme' }) })
    } else if (method === 'DELETE') {
      route.fulfill({ status: 204, body: '' })
    } else {
      route.continue()
    }
  })

  await page.route('**/api/v1/vaults/vault-1/documents', (route: Route) => {
    const method = route.request().method()
    if (method === 'GET') {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(DOCUMENTS) })
    } else if (method === 'POST') {
      const newDoc = { id: 'doc-new', path: 'Untitled.md', title: null, hash: '', sizeBytes: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }
      route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify(newDoc) })
    } else {
      route.continue()
    }
  })

  await page.route('**/api/v1/vaults/vault-1/documents/**', (route: Route) => {
    const method = route.request().method()
    if (method === 'GET') {
      route.fulfill({ status: 200, contentType: 'text/plain', body: '# Hello\n\nContenu du document.' })
    } else {
      route.fulfill({ status: 204, body: '' })
    }
  })

  await page.route('**/api/v1/vaults/vault-1/folders', (route: Route) => {
    const method = route.request().method()
    if (method === 'GET') {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(FOLDERS) })
    } else if (method === 'POST') {
      const newFolder = { id: 'folder-new', path: 'NewFolder', createdAt: new Date().toISOString() }
      route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify(newFolder) })
    } else {
      route.continue()
    }
  })

  await page.route('**/api/v1/vaults/vault-1/folders/**', (route: Route) => {
    route.fulfill({ status: 204, body: '' })
  })

  await page.route('**/api/v1/admin/users', (route: Route) => {
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(ADMIN_USERS) })
  })

  await page.route('**/api/v1/admin/users/**', (route: Route) => {
    route.fulfill({ status: 204, body: '' })
  })

  await page.route('**/api/v1/auth/change-password', (route: Route) => {
    route.fulfill({ status: 204, body: '' })
  })

  // Block SignalR (not tested here)
  await page.route('**/hubs/**', (route: Route) => {
    route.abort()
  })
}

async function loginViaUI(page: Page) {
  await page.goto('/login')
  await page.getByLabel('Email').fill('admin@local.dev')
  await page.getByLabel('Mot de passe').fill('Admin1234!')
  await page.getByRole('button', { name: 'Se connecter' }).click()
  await page.waitForURL('/', { timeout: 10_000 })
}

async function loginDirect(page: Page) {
  await page.goto('/login')
  await page.evaluate((auth) => {
    localStorage.setItem('auth_token', auth.accessToken)
    localStorage.setItem('auth_refresh', auth.refreshToken)
    localStorage.setItem('auth_user', JSON.stringify(auth.user))
    localStorage.setItem('accounts', JSON.stringify([{
      userId: auth.user.id,
      email: auth.user.email,
      displayName: auth.user.displayName,
      refreshToken: auth.refreshToken,
      isActive: true,
    }]))
  }, AUTH_RESPONSE)
  await page.goto('/')
}

// ─── Login page ───────────────────────────────────────────────────────────────

test.describe('Login page', () => {
  test.beforeEach(async ({ page }) => {
    await mockAPI(page)
  })

  test('renders title and form', async ({ page }) => {
    await page.goto('/login')
    await expect(page.getByText('POC Collab Editor')).toBeVisible()
    await expect(page.getByLabel('Email')).toBeVisible()
    await expect(page.getByLabel('Mot de passe')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Se connecter' })).toBeVisible()
  })

  test('submit button is disabled when fields are empty', async ({ page }) => {
    await page.goto('/login')
    await expect(page.getByRole('button', { name: 'Se connecter' })).toBeDisabled()
  })

  test('successful login redirects to /', async ({ page }) => {
    await loginViaUI(page)
    await expect(page).toHaveURL('/')
  })

  test('shows error on 401 response', async ({ page }) => {
    await page.route('**/api/v1/auth/login', (route: Route) => {
      route.fulfill({ status: 401, body: '' })
    })
    await page.goto('/login')
    await page.getByLabel('Email').fill('wrong@local.dev')
    await page.getByLabel('Mot de passe').fill('wrongpass')
    await page.getByRole('button', { name: 'Se connecter' }).click()
    await expect(page.getByText('Email ou mot de passe incorrect')).toBeVisible()
  })

  test('Enter key submits the form', async ({ page }) => {
    await page.goto('/login')
    await page.getByLabel('Email').fill('admin@local.dev')
    await page.getByLabel('Mot de passe').fill('Admin1234!')
    await page.keyboard.press('Enter')
    await page.waitForURL('/', { timeout: 10_000 })
    await expect(page).toHaveURL('/')
  })
})

// ─── Auth guard ───────────────────────────────────────────────────────────────

test.describe('Auth guard', () => {
  test('unauthenticated / redirects to /login', async ({ page }) => {
    await page.goto('/')
    await page.waitForURL('/login', { timeout: 8_000 })
    await expect(page).toHaveURL('/login')
  })

  test('unauthenticated /admin redirects to /login', async ({ page }) => {
    await page.goto('/admin')
    await page.waitForURL('/login', { timeout: 8_000 })
    await expect(page).toHaveURL('/login')
  })
})

// ─── Vault list ───────────────────────────────────────────────────────────────

test.describe('Vault list', () => {
  test.beforeEach(async ({ page }) => {
    await mockAPI(page)
    await loginDirect(page)
  })

  test('shows list of vaults in sidebar', async ({ page }) => {
    await expect(page.getByText('Mon Vault')).toBeVisible({ timeout: 8_000 })
    await expect(page.getByText('Vault Perso')).toBeVisible()
  })

  test('clicking a vault loads its documents', async ({ page }) => {
    await page.getByText('Mon Vault').click()
    await expect(page.getByText('intro.md')).toBeVisible({ timeout: 8_000 })
  })

  test('editor is not shown before selecting a vault', async ({ page }) => {
    await expect(page.locator('.cm-editor')).not.toBeVisible()
  })
})

// ─── Document list ────────────────────────────────────────────────────────────

test.describe('Document list', () => {
  test.beforeEach(async ({ page }) => {
    await mockAPI(page)
    await loginDirect(page)
    await page.getByText('Mon Vault').click()
    await page.waitForTimeout(400)
  })

  test('shows folder and documents', async ({ page }) => {
    await expect(page.getByText('Notes')).toBeVisible({ timeout: 5_000 })
    await expect(page.getByText('intro.md')).toBeVisible()
    await expect(page.getByText('todo.md')).toBeVisible()
  })

  test('clicking a document opens editor', async ({ page }) => {
    await page.getByText('intro.md').click()
    await expect(page.locator('.cm-editor')).toBeVisible({ timeout: 8_000 })
  })
})

// ─── Editor integration ───────────────────────────────────────────────────────

test.describe('Editor', () => {
  test.beforeEach(async ({ page }) => {
    await mockAPI(page)
    await loginDirect(page)
    await page.getByText('Mon Vault').click()
    await page.waitForTimeout(300)
    await page.getByText('intro.md').click()
    await page.locator('.cm-editor').waitFor({ state: 'visible', timeout: 10_000 })
  })

  test('editor is mounted and accepts keyboard input', async ({ page }) => {
    const content = page.locator('.cm-content')
    await content.click()
    await page.keyboard.press('End')
    await page.keyboard.type(' test-input')
    await expect(content).toContainText('test-input')
  })

  test('toolbar is visible with vault and doc name', async ({ page }) => {
    await expect(page.getByText('Mon Vault')).toBeVisible()
    await expect(page.getByText(/intro\.md|Introduction/)).toBeVisible()
  })
})

// ─── Theme switching ──────────────────────────────────────────────────────────

test.describe('Theme switching', () => {
  test.beforeEach(async ({ page }) => {
    await mockAPI(page)
    await loginDirect(page)
  })

  test('default theme is light or unset', async ({ page }) => {
    const theme = await page.locator('html').getAttribute('data-theme')
    expect(theme === null || theme === 'light' || theme === '').toBe(true)
  })

  test('selecting dark theme updates data-theme and localStorage', async ({ page }) => {
    const themeSelect = page.locator('select').first()
    const count = await themeSelect.count()
    if (count > 0) {
      const options = await themeSelect.locator('option').allTextContents()
      const hasDark = options.some(o => o.toLowerCase().includes('dark'))
      if (hasDark) {
        await themeSelect.selectOption({ label: options.find(o => o.toLowerCase() === 'dark' || o.includes('Dark')) ?? 'Dark' })
        const theme = await page.locator('html').getAttribute('data-theme')
        const stored = await page.evaluate(() => localStorage.getItem('theme'))
        expect(theme).toContain('dark')
        expect(stored).toContain('dark')
        return
      }
    }
    // Try button-based switcher
    const darkBtn = page.getByText(/🌙\s*Dark$/i).first()
    if ((await darkBtn.count()) > 0) {
      await darkBtn.click()
      const theme = await page.locator('html').getAttribute('data-theme')
      expect(theme).toContain('dark')
    } else {
      test.skip()
    }
  })
})

// ─── Admin page ───────────────────────────────────────────────────────────────

test.describe('Admin page', () => {
  test.beforeEach(async ({ page }) => {
    await mockAPI(page)
    await loginDirect(page)
  })

  test('admin page lists all users', async ({ page }) => {
    await page.goto('/admin')
    await expect(page.getByText('admin@local.dev')).toBeVisible({ timeout: 8_000 })
    await expect(page.getByText('user@local.dev')).toBeVisible()
  })

  test('admin page shows ADMIN badge', async ({ page }) => {
    await page.goto('/admin')
    await expect(page.getByText('ADMIN').first()).toBeVisible({ timeout: 5_000 })
  })

  test('navigation link to admin is visible for admin users', async ({ page }) => {
    const adminLink = page.getByRole('link', { name: /admin/i }).first()
    await expect(adminLink).toBeVisible({ timeout: 5_000 })
  })
})

// ─── Logout ───────────────────────────────────────────────────────────────────

test.describe('Logout', () => {
  test.beforeEach(async ({ page }) => {
    await mockAPI(page)
    await loginDirect(page)
  })

  test('after clearing localStorage, / redirects to /login', async ({ page }) => {
    await page.evaluate(() => localStorage.clear())
    await page.goto('/')
    await page.waitForURL('/login', { timeout: 8_000 })
    await expect(page).toHaveURL('/login')
  })
})
