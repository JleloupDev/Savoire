// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// see ADR-015

export type PipelineHook<T> = (value: T) => T | Promise<T>

export class DocumentPipeline {
  private beforeParseHooks: PipelineHook<string>[] = []
  private afterParseHooks: PipelineHook<unknown>[] = []
  private beforeRenderHooks: PipelineHook<unknown>[] = []
  private afterRenderHooks: PipelineHook<string>[] = []

  registerHook(stage: 'beforeParse' | 'afterRender', hook: PipelineHook<string>): void
  registerHook(stage: 'afterParse' | 'beforeRender', hook: PipelineHook<unknown>): void
  registerHook(stage: string, hook: PipelineHook<string> | PipelineHook<unknown>): void {
    switch (stage) {
      case 'beforeParse':
        this.beforeParseHooks.push(hook as PipelineHook<string>)
        break
      case 'afterParse':
        this.afterParseHooks.push(hook as PipelineHook<unknown>)
        break
      case 'beforeRender':
        this.beforeRenderHooks.push(hook as PipelineHook<unknown>)
        break
      case 'afterRender':
        this.afterRenderHooks.push(hook as PipelineHook<string>)
        break
      default:
        console.warn(`[DocumentPipeline] Unknown stage: ${stage}`)
    }
  }

  async runBeforeParse(source: string): Promise<string> {
    return this.runChain(source, this.beforeParseHooks)
  }

  async runAfterParse(ast: unknown): Promise<unknown> {
    return this.runChain(ast, this.afterParseHooks)
  }

  async runBeforeRender(ast: unknown): Promise<unknown> {
    return this.runChain(ast, this.beforeRenderHooks)
  }

  async runAfterRender(html: string): Promise<string> {
    return this.runChain(html, this.afterRenderHooks)
  }

  private async runChain<T>(value: T, hooks: PipelineHook<T>[]): Promise<T> {
    let current = value
    for (const hook of hooks) {
      current = await hook(current)
    }
    return current
  }
}
