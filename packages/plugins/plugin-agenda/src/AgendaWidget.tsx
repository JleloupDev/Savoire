// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Le calendrier du mois : un point sous les jours qui ont une note du jour ;
// un clic ouvre la note de ce jour, ou la cree.
import { useCallback, useEffect, useState } from 'react'
import type { ViewContext, Widget } from '@savoire/plugin-api'
import { dailyNotes, dayKey, monthGrid } from './daily'

const WEEKDAYS = ['L', 'M', 'M', 'J', 'V', 'S', 'D']

export interface AgendaHost {
  files(): Promise<string[]>
  openDay(key: string): Promise<void>
}

function AgendaPanel({ ctx, host }: { ctx: ViewContext; host: AgendaHost }) {
  const today = dayKey(new Date())
  const [month, setMonth] = useState(() => { const d = new Date(); return { y: d.getFullYear(), m: d.getMonth() } })
  const [days, setDays] = useState<Map<string, string>>(new Map())
  const [active, setActive] = useState<string | undefined>(undefined)

  const reload = useCallback(() => {
    void host.files().then(f => setDays(dailyNotes(f))).catch(() => {})
  }, [host])

  useEffect(() => {
    reload()
    return ctx.workspace.subscribeVaultChange?.(reload)
  }, [ctx, reload])

  useEffect(() => {
    const update = () => setActive(ctx.workspace.getActiveDocument?.()?.path)
    update()
    return ctx.workspace.subscribeActiveDocument?.(update)
  }, [ctx])

  const grid = monthGrid(month.y, month.m)
  const title = new Intl.DateTimeFormat('fr-FR', { month: 'long', year: 'numeric' }).format(new Date(month.y, month.m, 1))
  const shift = (n: number) => setMonth(({ y, m }) => { const d = new Date(y, m + n, 1); return { y: d.getFullYear(), m: d.getMonth() } })
  const btn: React.CSSProperties = { background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 13, padding: '2px 6px', borderRadius: 4 }

  return (
    <div data-testid="agenda" style={{ padding: '8px 10px', fontSize: 12, color: 'var(--text)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 2, marginBottom: 6 }}>
        <span style={{ flex: 1, fontWeight: 650, textTransform: 'capitalize', fontSize: 13 }}>{title}</span>
        <button style={btn} title="Mois précédent" onClick={() => shift(-1)}>‹</button>
        <button style={btn} data-testid="agenda-today" title="Note du jour" onClick={() => { const d = new Date(); setMonth({ y: d.getFullYear(), m: d.getMonth() }); void host.openDay(today) }}>Aujourd'hui</button>
        <button style={btn} title="Mois suivant" onClick={() => shift(1)}>›</button>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 2, textAlign: 'center' }}>
        {WEEKDAYS.map((d, i) => <div key={i} style={{ fontSize: 10, fontWeight: 600, color: 'var(--text-faint)', paddingBottom: 2 }}>{d}</div>)}
        {grid.map(d => {
          const key = dayKey(d)
          const note = days.get(key)
          const inMonth = d.getMonth() === month.m
          const isOpen = !!note && note === active
          return (
            <button
              key={key}
              data-testid="agenda-day"
              data-day={key}
              data-has-note={note ? 'true' : 'false'}
              title={note ?? `Créer la note du ${key}`}
              onClick={() => void host.openDay(key)}
              style={{
                position: 'relative', height: 30, border: 'none', borderRadius: 6, cursor: 'pointer',
                fontSize: 12, fontVariantNumeric: 'tabular-nums',
                background: isOpen ? 'var(--accent-dim)' : 'transparent',
                color: key === today ? 'var(--accent)' : inMonth ? 'var(--text)' : 'var(--text-faint)',
                fontWeight: key === today ? 700 : 400,
                outline: key === today ? '1px solid var(--accent)' : 'none',
              }}
            >
              {d.getDate()}
              {note && <span style={{ position: 'absolute', left: '50%', bottom: 3, width: 4, height: 4, marginLeft: -2, borderRadius: '50%', background: 'var(--accent)' }} />}
            </button>
          )
        })}
      </div>
    </div>
  )
}

export class AgendaWidget implements Widget {
  constructor(private readonly ctx: ViewContext, private readonly host: AgendaHost) {}
  render() {
    return <AgendaPanel ctx={this.ctx} host={this.host} />
  }
}
