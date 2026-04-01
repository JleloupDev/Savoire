// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import { test, expect } from '@playwright/test'

// ─── Smoke ──────────────────────────────────────────────────────────────────

test.describe('Smoke', () => {
  test('editor mounts', async ({ page }) => {
    await page.goto('/')
    await expect(page.locator('.cm-editor')).toBeVisible({ timeout: 10_000 })
  })

  test('accepts keyboard input', async ({ page }) => {
    await page.goto('/')
    await page.locator('.cm-content').click()
    await page.keyboard.press('End')
    await page.keyboard.type(' hello')
    await expect(page.locator('.cm-content')).toContainText('hello')
  })
})
