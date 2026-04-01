// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
/**
 * E2E tests for editor-dev (http://localhost:3001).
 * Each group targets one specific behaviour introduced in development.
 * Run: pnpm test:e2e  (from frontend/)
 */
import { test, expect, type Page } from '@playwright/test'

// Helper: wait for plugins to load and decorations to render
async function waitForRenderedBlocks(page: Page) {
  // pluginsLoadedEffect is dispatched ~synchronously after onload() — 500ms is ample
  await page.waitForTimeout(500)
}

async function selectScenario(page: Page, label: string) {
  await page.getByText(label, { exact: true }).click()
  await waitForRenderedBlocks(page)
}

// ─── Initial render ──────────────────────────────────────────────────────────

test.describe('Initial render', () => {
  test('blocks are rendered on load without any click', async ({ page }) => {
    await page.goto('/')
    await waitForRenderedBlocks(page)
    // A rendered callout has class "callout" — should exist without clicking editor
    const callout = page.locator('.callout').first()
    await expect(callout).toBeVisible({ timeout: 5_000 })
  })

  test('rendered block shows callout title', async ({ page }) => {
    await page.goto('/')
    await selectScenario(page, 'Callouts')
    const title = page.locator('.callout-title').first()
    await expect(title).toBeVisible()
  })
})

// ─── Callout rendering ───────────────────────────────────────────────────────

test.describe('Callout blocks', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await selectScenario(page, 'Callouts')
  })

  test('renders NOTE callout', async ({ page }) => {
    await expect(page.locator('.callout-note, .callout[class*="note"]').first()).toBeVisible()
  })

  test('renders WARNING callout', async ({ page }) => {
    await expect(page.locator('.callout[class*="warning"]').first()).toBeVisible()
  })

  test('renders DANGER callout', async ({ page }) => {
    await expect(page.locator('.callout[class*="danger"]').first()).toBeVisible()
  })

  test('renders TODO callout', async ({ page }) => {
    await expect(page.locator('.callout[class*="todo"]').first()).toBeVisible()
  })

  test('unknown type renders with fallback note style', async ({ page }) => {
    // "UNKNOWN" type should still produce a callout element
    const callouts = page.locator('.callout')
    const count = await callouts.count()
    expect(count).toBeGreaterThanOrEqual(6) // NOTE,TIP,WARNING,DANGER,TODO,QUESTION,UNKNOWN
  })

  test('callout has both title and body', async ({ page }) => {
    const first = page.locator('.callout').first()
    await expect(first.locator('.callout-title')).toBeVisible()
    await expect(first.locator('.callout-body')).toBeVisible()
  })
})

// ─── Block editing (click to enter) ─────────────────────────────────────────

test.describe('Block editing', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await selectScenario(page, 'Callouts')
  })

  test('clicking a rendered callout enters edit mode (shows raw text)', async ({ page }) => {
    const callout = page.locator('.callout').first()
    await callout.click()
    // After click the decoration is removed — raw ">" text should be visible in cm-content
    await expect(page.locator('.cm-content')).toContainText('[!NOTE]')
  })

  test('clicking away from raw block re-renders it', async ({ page }) => {
    const callout = page.locator('.callout').first()
    await callout.click()
    // Click on a line that's not part of the block
    await page.locator('.cm-content').click({ position: { x: 100, y: 10 } })
    await expect(page.locator('.callout').first()).toBeVisible()
  })
})

// ─── Arrow navigation ────────────────────────────────────────────────────────

test.describe('Arrow navigation', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await selectScenario(page, 'Basic Markdown')
    await waitForRenderedBlocks(page)
  })

  test('ArrowDown enters a rendered block (shows raw text)', async ({ page }) => {
    const content = page.locator('.cm-content')
    await content.click()
    // Move to start of document
    await page.keyboard.press('Control+Home')
    // Press ArrowDown until we find raw markdown (the heading is on line 1, so
    // first ArrowDown should land inside the heading block)
    await page.keyboard.press('ArrowDown')
    // After entering a block, the rendered widget disappears — raw # heading visible
    const hasRaw = await page.locator('.cm-line').filter({ hasText: '#' }).count()
    expect(hasRaw).toBeGreaterThan(0)
  })
})

// ─── Blockquote exit ─────────────────────────────────────────────────────────

test.describe('Blockquote exit', () => {
  test('pressing Enter on an empty > line exits the blockquote', async ({ page }) => {
    await page.goto('/')
    const content = page.locator('.cm-content')
    await content.click()
    await page.keyboard.press('Control+End')
    // Type a blockquote line then an empty continuation
    await page.keyboard.type('> first line')
    await page.keyboard.press('Enter')   // auto-continues with "> "
    await page.keyboard.press('Enter')   // on empty "> " — should exit
    await page.keyboard.type('outside')
    // The word "outside" should not have a ">" prefix
    const lines = await page.locator('.cm-line').allTextContents()
    const outsideLine = lines.find(l => l.includes('outside'))
    expect(outsideLine).toBeDefined()
    expect(outsideLine).not.toMatch(/^>/)
  })
})

// ─── Wikilinks ───────────────────────────────────────────────────────────────

test.describe('Wikilinks', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await selectScenario(page, 'Embeds (Wikilinks)')
  })

  test('[[note.md]] is rendered as an anchor', async ({ page }) => {
    // The rendered block should contain an <a> tag from the wikilinks hook
    const link = page.locator('.vault-rendered-block a').first()
    await expect(link).toBeVisible()
    await expect(link).toContainText('note.md')
  })
})

// ─── Scenario switching ──────────────────────────────────────────────────────

test.describe('Scenario switching', () => {
  test('switching scenario re-renders the editor with new content', async ({ page }) => {
    await page.goto('/')
    await waitForRenderedBlocks(page)

    // Start on Basic Markdown — heading should be present
    await expect(page.locator('.vault-rendered-block h1').first()).toBeVisible()

    // Switch to Callouts
    await selectScenario(page, 'Callouts')
    await expect(page.locator('.callout').first()).toBeVisible()

    // Switch back to Basic Markdown
    await selectScenario(page, 'Basic Markdown')
    await expect(page.locator('.vault-rendered-block h1').first()).toBeVisible()
  })

  test('Large scenario loads without crash', async ({ page }) => {
    await page.goto('/')
    await selectScenario(page, 'Large Document (perf)')
    // Should still have a visible editor
    await expect(page.locator('.cm-editor')).toBeVisible()
  })
})
