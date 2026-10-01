// Market features: search, market overview, readymade scans and the stock
// page. Same look as the rest of the app -- these reuse its cards, pills
// and type; only layout pieces specific to them live in index.css.
import { useEffect, useMemo, useRef, useState } from 'react'
import { getMarket, getScan, getStock, searchSymbols } from './api'

const bare = (s) => (s || '').replace(/\.NS$/, '')
export const fmtPct = (p) => (p == null ? '—' : `${p >= 0 ? '+' : ''}${(p * 100).toFixed(2)}%`)
export const fmtPrice = (n) =>
  n == null ? '—' : `₹${Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const fmtNum = (n) => (n == null ? '—' : Math.round(n).toLocaleString('en-IN'))
const fmtCr = (n) => (n == null ? '—' : `₹${(n / 1e7).toLocaleString('en-IN', { maximumFractionDigits: 1 })} Cr`)
const dir = (p) => (p == null ? 'flat' : p >= 0 ? 'up' : 'down')

function useDebounced(value, ms) {
  const [v, setV] = useState(value)
  useEffect(() => {
    const id = setTimeout(() => setV(value), ms)
    return () => clearTimeout(id)
  }, [value, ms])
  return v
}

// ── Search with suggestions ───────────────────────────────────────────

export function SymbolSearch({ onPick, placeholder = 'search a stock... 🔍', buttonLabel = '+ add' }) {
  const [q, setQ] = useState('')
  const [results, setResults] = useState([])
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const debounced = useDebounced(q, 200)
  const boxRef = useRef(null)

  useEffect(() => {
    let live = true
    if (debounced.trim().length < 2) {
      setResults([])
      return
    }
    searchSymbols(debounced)
      .then((d) => live && (setResults(d.results), setActive(0)))
      .catch(() => live && setResults([]))
    return () => {
      live = false
    }
  }, [debounced])

  useEffect(() => {
    const close = (e) => boxRef.current && !boxRef.current.contains(e.target) && setOpen(false)
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [])

  const pick = (symbol) => {
    onPick(symbol)
    setQ('')
    setResults([])
    setOpen(false)
  }

  const submit = (e) => {
    e.preventDefault()
    if (results[active]) pick(results[active].symbol)
    else if (q.trim()) {
      // No match: hand the typed ticker over as-is, like the old add box.
      pick(q.trim().toUpperCase())
    }
  }

  return (
    <form className="add-form search-box" onSubmit={submit} ref={boxRef}>
      <input
        value={q}
        onChange={(e) => {
          setQ(e.target.value)
          setOpen(true)
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') setActive((a) => Math.min(a + 1, results.length - 1))
          if (e.key === 'ArrowUp') setActive((a) => Math.max(a - 1, 0))
          if (e.key === 'Escape') setOpen(false)
        }}
        placeholder={placeholder}
        aria-label="search stocks"
      />
      <button type="submit">{buttonLabel}</button>
      {open && results.length > 0 && (
        <ul className="search-results" role="listbox">
          {results.map((r, i) => (
            <li
              key={r.symbol}
              role="option"
              aria-selected={i === active}
              className={i === active ? 'active' : ''}
              onMouseDown={(e) => {
                e.preventDefault()
                pick(r.symbol)
              }}
              onMouseEnter={() => setActive(i)}
            >
              <span className="sr-sym">
                {bare(r.symbol)}
                {r.kind === 'etf' && <em> etf</em>}
              </span>
              <span className="sr-name">{r.name}</span>
              <span className="sr-price">{r.close != null ? fmtPrice(r.close) : ''}</span>
            </li>
          ))}
        </ul>
      )}
    </form>
  )
}

// ── A row of a mover/scan list ────────────────────────────────────────

function StockRow({ row, extra, onOpen }) {
  return (
    <li className="mkt-row" onClick={() => onOpen(row.symbol)} tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && onOpen(row.symbol)}>
      <div className="mkt-id">
        <span className="symbol">{bare(row.symbol)}</span>
        <span className="mkt-name">{row.name}</span>
      </div>
      {extra && <span className="mkt-extra">{extra}</span>}
      <div className="mkt-quote">
        <span className="price">{fmtPrice(row.close)}</span>
        <span className={`change ${dir(row.pct)}`}>{fmtPct(row.pct)}</span>
      </div>
    </li>
  )
}

// ── Market overview (Groww "Explore") ─────────────────────────────────

// How many companies rose vs fell -- the whole market's mood in one bar.
function Breadth({ breadth }) {
  if (!breadth) return null
  const { advances, declines, unchanged } = breadth
  const total = advances + declines + unchanged || 1
  const upShare = advances / total
  const verdict = upShare >= 0.6 ? 'most stocks rose 🌷' : upShare <= 0.4 ? 'most stocks fell 🥀' : 'a mixed day 🌗'
  return (
    <section className="pane breadth">
      <div className="breadth-head">
        <span className="index-name">market breadth</span>
        <span className="breadth-verdict">{verdict}</span>
      </div>
      <div className="breadth-bar" role="img" aria-label={`${advances} up, ${declines} down, ${unchanged} unchanged`}>
        <span className="breadth-up" style={{ width: `${(advances / total) * 100}%` }} />
        <span className="breadth-flat" style={{ width: `${(unchanged / total) * 100}%` }} />
        <span className="breadth-down" style={{ width: `${(declines / total) * 100}%` }} />
      </div>
      <div className="breadth-legend">
        <span>▲ {advances.toLocaleString('en-IN')} up</span>
        <span>{unchanged} flat</span>
        <span>▼ {declines.toLocaleString('en-IN')} down</span>
      </div>
    </section>
  )
}

// India VIX: expected volatility. It rising means traders are more nervous,
// so it gets its own wording instead of the usual up-is-good pill.
function VixCard({ vix }) {
  const level = vix.price < 13 ? 'calm' : vix.price < 18 ? 'a little jittery' : vix.price < 25 ? 'nervous' : 'scared'
  return (
    <section className="pane vix" title="India VIX: how much movement traders expect over the next month">
      <span className="index-name">fear gauge · india vix</span>
      <span className="index-price">{vix.price.toFixed(2)}</span>
      <span className="vix-line">
        traders feel <strong>{level}</strong>
        {vix.pct_change != null && <> · {vix.pct_change >= 0 ? 'up' : 'down'} {Math.abs(vix.pct_change * 100).toFixed(1)}% today</>}
      </span>
    </section>
  )
}

// Sector heat tiles: deeper pink the more a sector rose, deeper mauve the
// more it fell (saturating at 3%).
function Sectors({ sectors }) {
  if (!sectors?.length) return null
  const sorted = [...sectors].filter((s) => s.pct_change != null).sort((a, b) => b.pct_change - a.pct_change)
  return (
    <section className="pane">
      <h2>🎨 sectors today</h2>
      <div className="sector-grid">
        {sorted.map((s) => {
          const strength = Math.min(Math.abs(s.pct_change) / 0.03, 1)
          const style = { '--heat': (0.4 + strength * 0.6).toFixed(2) }
          return (
            <div key={s.symbol} className={`sector-tile ${dir(s.pct_change)}`} style={style}>
              <span className="sector-name">{s.name}</span>
              <span className="sector-pct">{fmtPct(s.pct_change)}</span>
            </div>
          )
        })}
      </div>
    </section>
  )
}

export function MarketView({ onOpen }) {
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    getMarket().then(setData).catch((e) => setError(e.message))
  }, [])

  if (error) return <div className="error-banner">{error}</div>
  if (!data) return <p className="empty">fetching the market…</p>

  const lists = [
    ['gainers', '🚀 top gainers'],
    ['losers', '🥀 top losers'],
    ['most_active', '🔥 most active'],
  ]
  const vix = data.indices.find((i) => i.symbol === '^INDIAVIX')
  return (
    <div className="mkt">
      <div className="index-strip">
        {data.indices
          .filter((i) => i !== vix)
          .map((i) => (
            <section className="pane index-card" key={i.symbol}>
              <span className="index-name">{i.name}</span>
              <span className="index-price">{i.price != null ? i.price.toLocaleString('en-IN', { maximumFractionDigits: 2 }) : '—'}</span>
              <span className={`change ${dir(i.pct_change)}`}>{fmtPct(i.pct_change)}</span>
            </section>
          ))}
      </div>
      <div className="mood-strip">
        <Breadth breadth={data.breadth} />
        {vix?.price != null && <VixCard vix={vix} />}
      </div>
      <Sectors sectors={data.sectors} />
      <p className="inbox-subtitle">movers across every listed NSE company · closing data for {data.as_of_date}</p>
      <div className="mover-grid">
        {lists.map(([key, title]) => (
          <section className="pane" key={key}>
            <h2>{title}</h2>
            <ul className="mkt-list">
              {data.movers[key].map((r) => (
                <StockRow key={r.symbol} row={r} onOpen={onOpen} extra={key === 'most_active' ? fmtCr(r.traded_value) : null} />
              ))}
            </ul>
          </section>
        ))}
      </div>
    </div>
  )
}

// ── Readymade scans (StockEdge / Trendlyne style) ─────────────────────

const SCAN_ORDER = ['volume_shockers', 'high_delivery', 'block_trades', 'near_high', 'gainers', 'losers', 'most_active']
const SCAN_EMOJI = {
  volume_shockers: '📢',
  high_delivery: '💎',
  block_trades: '🐋',
  near_high: '⛰️',
  gainers: '🚀',
  losers: '🥀',
  most_active: '🔥',
}
const SCAN_WHY = {
  volume_shockers: 'traded at 3x or more of their own usual 20-day volume today. something got people interested.',
  high_delivery: "60%+ of today's volume was taken as delivery: buyers holding the shares, not just day-trading them.",
  block_trades: 'a few very large trades moved real size today, often institutions buying or selling.',
  near_high: 'closing within 2% of the highest price in the history we hold (about the last 3–4 months).',
  gainers: "today's biggest rises among companies with real trading activity (₹1 Cr+ traded, price ₹20+).",
  losers: "today's biggest falls among companies with real trading activity.",
  most_active: 'the companies with the most money traded today.',
}

function scanExtra(scan, r) {
  if (scan === 'volume_shockers' && r.vol_ratio) return `${r.vol_ratio.toFixed(1)}x vol`
  if (scan === 'high_delivery' && r.deliv_pct != null) return `${r.deliv_pct.toFixed(0)}% deliv`
  if (scan === 'block_trades' && r.size_ratio) return `${r.size_ratio.toFixed(1)}x lot`
  if (scan === 'most_active') return fmtCr(r.traded_value)
  return null
}

export function ScansView({ onOpen }) {
  const [scan, setScan] = useState('volume_shockers')
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    let live = true
    setData(null)
    getScan(scan)
      .then((d) => live && setData(d))
      .catch((e) => live && setError(e.message))
    return () => {
      live = false
    }
  }, [scan])

  return (
    <section className="pane">
      <h2>✨ readymade scans</h2>
      <div className="lens-switcher scan-chips">
        {SCAN_ORDER.map((s) => (
          <button key={s} className={scan === s ? 'lens-btn active' : 'lens-btn'} onClick={() => setScan(s)}>
            {SCAN_EMOJI[s]} {s.replace('_', ' ')}
          </button>
        ))}
      </div>
      <p className="inbox-subtitle">{SCAN_WHY[scan]}</p>
      {error && <div className="error-banner">{error}</div>}
      {!data ? (
        <p className="empty">scanning ~2,600 companies…</p>
      ) : data.results.length === 0 ? (
        <div className="notice-card">
          <p className="notice-headline">🌸 nothing matched today</p>
          <p className="notice-body">no company met this scan's bar on {data.as_of_date}.</p>
        </div>
      ) : (
        <>
          <ul className="mkt-list">
            {data.results.map((r) => (
              <StockRow key={r.symbol} row={r} onOpen={onOpen} extra={scanExtra(scan, r)} />
            ))}
          </ul>
          <p className="notice-asof">closing data for {data.as_of_date} · {data.results.length} results</p>
        </>
      )}
    </section>
  )
}

// ── Price chart (hand-drawn SVG, no charting library) ─────────────────

const RANGES = [
  ['1m', 22],
  ['3m', 66],
  ['6m', 130],
  ['1y', 400],
]

function PriceChart({ bars }) {
  const [range, setRange] = useState('3m')
  const [hover, setHover] = useState(null)
  const pts = useMemo(() => bars.slice(-RANGES.find((r) => r[0] === range)[1]), [bars, range])
  if (pts.length < 2) return <p className="empty">not enough price history to draw a chart.</p>

  const W = 600
  const H = 220
  const PAD = { l: 8, r: 8, t: 14, b: 22 }
  const closes = pts.map((b) => b.c)
  const lo = Math.min(...closes)
  const hi = Math.max(...closes)
  const span = hi - lo || 1
  const x = (i) => PAD.l + (i / (pts.length - 1)) * (W - PAD.l - PAD.r)
  const y = (c) => PAD.t + (1 - (c - lo) / span) * (H - PAD.t - PAD.b)
  const line = pts.map((b, i) => `${x(i).toFixed(1)},${y(b.c).toFixed(1)}`).join(' ')
  const up = closes[closes.length - 1] >= closes[0]
  const color = up ? 'var(--accent)' : 'var(--down)'
  const change = closes[closes.length - 1] / closes[0] - 1
  const hi_i = closes.indexOf(hi)
  const lo_i = closes.indexOf(lo)
  const h = hover != null ? pts[hover] : null

  const onMove = (e) => {
    const r = e.currentTarget.getBoundingClientRect()
    const fx = ((e.clientX - r.left) / r.width) * W
    const i = Math.round(((fx - PAD.l) / (W - PAD.l - PAD.r)) * (pts.length - 1))
    setHover(Math.max(0, Math.min(pts.length - 1, i)))
  }

  return (
    <div className="chart">
      <div className="chart-head">
        <span className="chart-readout">
          {h ? (
            <>
              <strong>{fmtPrice(h.c)}</strong> on {new Date(h.t).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}
            </>
          ) : (
            <>
              <span className={`change ${dir(change)}`}>{fmtPct(change)}</span> over {range}
            </>
          )}
        </span>
        <div className="lens-switcher">
          {RANGES.map(([r]) => (
            <button key={r} className={range === r ? 'lens-btn active' : 'lens-btn'} onClick={() => setRange(r)}>
              {r}
            </button>
          ))}
        </div>
      </div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="chart-svg"
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
        role="img"
        aria-label={`price chart, ${fmtPct(change)} over ${range}`}
      >
        <defs>
          <linearGradient id="chart-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={up ? '#e91e8c' : '#9a6b85'} stopOpacity="0.28" />
            <stop offset="100%" stopColor={up ? '#e91e8c' : '#9a6b85'} stopOpacity="0" />
          </linearGradient>
        </defs>
        <polygon points={`${PAD.l},${H - PAD.b} ${line} ${W - PAD.r},${H - PAD.b}`} fill="url(#chart-fill)" />
        <polyline points={line} fill="none" stroke={color} strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" />
        <text x={Math.min(Math.max(x(hi_i), 40), W - 40)} y={y(hi) - 4} className="chart-label" textAnchor="middle">
          {fmtPrice(hi)}
        </text>
        <text x={Math.min(Math.max(x(lo_i), 40), W - 40)} y={Math.min(y(lo) + 14, H - 4)} className="chart-label" textAnchor="middle">
          {fmtPrice(lo)}
        </text>
        <circle cx={x(pts.length - 1)} cy={y(closes[closes.length - 1])} r="4" fill={color} stroke="#fff" strokeWidth="2" />
        {h && (
          <>
            <line x1={x(hover)} x2={x(hover)} y1={PAD.t} y2={H - PAD.b} stroke="var(--muted)" strokeDasharray="3 3" />
            <circle cx={x(hover)} cy={y(h.c)} r="5" fill="#fff" stroke={color} strokeWidth="2.5" />
          </>
        )}
      </svg>
    </div>
  )
}

// ── Stock page (Groww-style), shown as a sheet over the app ───────────

function RangeBar({ low, high, value, label }) {
  if (low == null || high == null || value == null || high <= low) return null
  const pos = Math.max(0, Math.min(1, (value - low) / (high - low))) * 100
  return (
    <div className="range-bar">
      <div className="range-labels">
        <span>{fmtPrice(low)}</span>
        <span className="range-title">{label}</span>
        <span>{fmtPrice(high)}</span>
      </div>
      <div className="range-track">
        <span className="range-dot" style={{ left: `${pos}%` }} />
      </div>
    </div>
  )
}

const EVENT_LABEL = { RESIDUAL_MOVE: '🚀 unusual move', DELIVERY_CONVICTION: '💰 delivery buying', BLOCK_TRADE: '🐋 block trade' }

export function StockSheet({ symbol, inWatchlist, onAdd, onClose }) {
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    let live = true
    setData(null)
    setError(null)
    getStock(symbol)
      .then((d) => live && setData(d))
      .catch((e) => live && setError(e.message))
    const onKey = (e) => e.key === 'Escape' && onClose()
    document.addEventListener('keydown', onKey)
    return () => {
      live = false
      document.removeEventListener('keydown', onKey)
    }
  }, [symbol, onClose])

  return (
    <div className="sheet-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="pane sheet" role="dialog" aria-label={`${bare(symbol)} details`}>
        <button className="chat-close sheet-close" onClick={onClose} aria-label="close">
          ×
        </button>
        {error ? (
          <div className="notice-card">
            <p className="notice-headline">🥺 couldn't load {bare(symbol)}</p>
            <p className="notice-body">{error}</p>
          </div>
        ) : !data ? (
          <p className="empty">loading {bare(symbol)}…</p>
        ) : (
          <>
            <div className="sheet-head">
              <div>
                <h2>{bare(data.symbol)}</h2>
                <p className="mkt-name">
                  {data.name} · {data.exchange || 'NSE'}
                </p>
              </div>
              {inWatchlist ? (
                <span className="glance-pill muted">on your watchlist</span>
              ) : (
                <button className="ack-btn sheet-add" onClick={() => onAdd(data.symbol)}>
                  💗 add to watchlist
                </button>
              )}
            </div>
            <div className="sheet-price">
              <span className="big-price">{fmtPrice(data.price)}</span>
              <span className={`change ${dir(data.pct_change)}`}>{fmtPct(data.pct_change)} today</span>
              <span className={`badge badge-${data.staleness}`}>{data.staleness === 'closed' ? '🌙 last close' : data.staleness}</span>
            </div>

            <PriceChart bars={data.bars} />

            <div className="stat-grid">
              <RangeBar low={data.day_low} high={data.day_high} value={data.price} label="today's range" />
              <RangeBar low={data.week52_low} high={data.week52_high} value={data.price} label="52-week range" />
            </div>

            <dl className="stat-list">
              <div>
                <dt>previous close</dt>
                <dd>{fmtPrice(data.prev_close)}</dd>
              </div>
              <div>
                <dt>volume</dt>
                <dd>{fmtNum(data.volume)}</dd>
              </div>
              <div>
                <dt>avg volume (20d)</dt>
                <dd>{fmtNum(data.avg_volume_20d)}</dd>
              </div>
              <div>
                <dt>delivery %</dt>
                <dd>{data.deliv_pct != null ? `${data.deliv_pct.toFixed(1)}%` : '—'}</dd>
              </div>
              <div>
                <dt>trades</dt>
                <dd>{fmtNum(data.total_trades)}</dd>
              </div>
              <div>
                <dt>52-week high</dt>
                <dd>{fmtPrice(data.week52_high)}</dd>
              </div>
            </dl>

            <h3 className="sheet-sub">🔔 recent alerts</h3>
            {data.events?.length ? (
              <ul className="mkt-list">
                {data.events.map((e, i) => (
                  <li className="event-line" key={i}>
                    <span className="event-type-chip">{EVENT_LABEL[e.type] || e.type}</span>
                    <span className="event-text">{e.reason}</span>
                    <span className="event-time">{new Date(e.occurred_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="empty">no alerts for {bare(data.symbol)} in the last 45 days.</p>
            )}
            {data.as_of_date && <p className="notice-asof">nse delivery data as of {data.as_of_date}</p>}
          </>
        )}
      </div>
    </div>
  )
}
