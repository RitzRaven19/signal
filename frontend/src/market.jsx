// Market features: search, market overview, readymade scans and the stock
// page. Same look as the rest of the app -- these reuse its cards, pills
// and type; only layout pieces specific to them live in index.css.
import { useEffect, useMemo, useRef, useState } from 'react'
import { getMarket, getScan, getStock, searchSymbols } from './api'
import { StockNews, UnusualMoves } from './incidents'
import { ex } from './explain'
import { GroovyText, MiniLoader } from './groovy'

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
    <section className="pane breadth" {...ex('breadth')}>
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
    <section className="pane vix" {...ex('vix')}>
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
      <h2 className="groovy-title"><GroovyText text={'🎨 sectors today'} /></h2>
      <div className="sector-grid">
        {sorted.map((s) => {
          const strength = Math.min(Math.abs(s.pct_change) / 0.03, 1)
          const style = { '--heat': (0.4 + strength * 0.6).toFixed(2) }
          return (
            <div key={s.symbol} className={`sector-tile ${dir(s.pct_change)}`} style={style} {...ex('sector')}>
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
  if (!data) return <MiniLoader text="fetching the market…" />

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
            <section className="pane index-card" key={i.symbol} {...ex('index')}>
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
      <UnusualMoves onOpen={onOpen} />
      <p className="inbox-subtitle">movers across every listed NSE company · closing data for {data.as_of_date}</p>
      <div className="mover-grid">
        {lists.map(([key, title]) => (
          <section className="pane" key={key}>
            <h2 className="groovy-title" {...ex(key === 'most_active' ? 'most-active' : key)}><GroovyText text={title} /></h2>
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
  near_high: 'closing within 2% of their highest price in the last 52 weeks.',
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
      <h2 className="groovy-title" {...ex('scans')}><GroovyText text={'✨ readymade scans'} /></h2>
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
        <MiniLoader text="scanning ~2,600 companies…" />
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

// ── Indicators (computed in the browser from the daily bars) ──────────

// Simple moving average; null until there are n closes to average.
export function sma(closes, n) {
  const out = new Array(closes.length).fill(null)
  let sum = 0
  closes.forEach((c, i) => {
    sum += c
    if (i >= n) sum -= closes[i - n]
    if (i >= n - 1) out[i] = sum / n
  })
  return out
}

// Wilder's 14-day RSI, the standard one charting sites show.
export function rsi(closes, n = 14) {
  if (closes.length <= n) return null
  let gain = 0
  let loss = 0
  for (let i = 1; i <= n; i++) {
    const d = closes[i] - closes[i - 1]
    if (d > 0) gain += d
    else loss -= d
  }
  gain /= n
  loss /= n
  for (let i = n + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1]
    gain = (gain * (n - 1) + Math.max(d, 0)) / n
    loss = (loss * (n - 1) + Math.max(-d, 0)) / n
  }
  return loss === 0 ? 100 : 100 - 100 / (1 + gain / loss)
}

// ── Price chart (hand-drawn SVG, no charting library) ─────────────────

// Point counts are period + 1, so the chart's change matches the returns table.
const RANGES = [
  ['1m', 22],
  ['3m', 64],
  ['6m', 127],
  ['1y', 253],
  ['2y', 600],
]

const AVERAGES = [
  ['sma50', '50d avg', 50],
  ['sma200', '200d avg', 200],
]

// Fund ranges are by calendar days: the chart starts at the last NAV on or
// before that date, the same base the backend's fund returns use.
export const FUND_RANGES = [
  ['1m', { days: 30 }],
  ['6m', { days: 182 }],
  ['1y', { days: 365 }],
  ['3y', { days: 365 * 3 }],
  ['5y', { days: 365 * 5 }],
  ['all', { days: Infinity }],
]

function pointCount(bars, spec) {
  if (typeof spec === 'number') return spec
  if (spec.days === Infinity) return bars.length
  const target = new Date(new Date(bars[bars.length - 1].t).getTime() - spec.days * 86400000).toISOString().slice(0, 10)
  let start = 0
  for (let i = bars.length - 1; i >= 0; i--) {
    if (bars[i].t <= target) {
      start = i
      break
    }
  }
  return bars.length - start
}

export function PriceChart({ bars, ranges = RANGES, defaultRange = '3m', withAverages = true }) {
  const [range, setRange] = useState(defaultRange)
  const [hover, setHover] = useState(null)
  const [shown, setShown] = useState({ sma50: false, sma200: false })
  const closesAll = useMemo(() => bars.map((b) => b.c), [bars])
  const averages = useMemo(
    () => Object.fromEntries(AVERAGES.map(([key, , n]) => [key, sma(closesAll, n)])),
    [closesAll],
  )
  const count = pointCount(bars, ranges.find((r) => r[0] === range)[1])
  const pts = useMemo(() => bars.slice(-count), [bars, count])
  const lines = AVERAGES.filter(([key]) => shown[key]).map(([key, label]) => [key, label, averages[key].slice(-count)])
  if (pts.length < 2) return <p className="empty">not enough price history to draw a chart.</p>

  const W = 600
  const H = 220
  const PAD = { l: 8, r: 8, t: 14, b: 22 }
  const closes = pts.map((b) => b.c)
  const lo = Math.min(...closes)
  const hi = Math.max(...closes)
  // The y-scale also fits any average line shown, so it can't run off the chart.
  const avgVals = lines.flatMap(([, , vals]) => vals.filter((v) => v != null))
  const yLo = Math.min(lo, ...avgVals)
  const yHi = Math.max(hi, ...avgVals)
  const span = yHi - yLo || 1
  const x = (i) => PAD.l + (i / (pts.length - 1)) * (W - PAD.l - PAD.r)
  const y = (c) => PAD.t + (1 - (c - yLo) / span) * (H - PAD.t - PAD.b)
  const line = pts.map((b, i) => `${x(i).toFixed(1)},${y(b.c).toFixed(1)}`).join(' ')
  const avgPath = (vals) =>
    vals
      .map((v, i) => (v == null ? null : `${x(i).toFixed(1)},${y(v).toFixed(1)}`))
      .filter(Boolean)
      .join(' ')
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
    <div className="chart" {...ex('chart')}>
      <div className="chart-head">
        <span className="chart-readout">
          {h ? (
            <>
              <strong>{fmtPrice(h.c)}</strong> on {new Date(h.t).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}
              {lines.map(([key, label, vals]) =>
                vals[hover] != null ? (
                  <span key={key} className={`chart-key chart-key-${key}`}>
                    {' '}
                    · {label} {fmtPrice(vals[hover])}
                  </span>
                ) : null,
              )}
            </>
          ) : (
            <>
              <span className={`change ${dir(change)}`}>{fmtPct(change)}</span> over {range}
            </>
          )}
        </span>
        <div className="lens-switcher">
          {ranges.map(([r]) => (
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
        {lines.map(([key, , vals]) => (
          <polyline key={key} points={avgPath(vals)} className={`chart-avg chart-${key}`} fill="none" />
        ))}
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
      {withAverages && (
        <div className="chart-toggles" {...ex('averages')}>
          {AVERAGES.map(([key, label, n]) => (
            <button
              key={key}
              className={`avg-toggle avg-${key}${shown[key] ? ' on' : ''}`}
              onClick={() => setShown((v) => ({ ...v, [key]: !v[key] }))}
              disabled={closesAll.length < n}
              title={closesAll.length < n ? `needs ${n} days of history` : `average close of the last ${n} trading days`}
            >
              <i aria-hidden="true" /> {label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

// Groww-style returns over standard periods, from the daily closes.
const PERIODS = [
  ['1 week', 5],
  ['1 month', 21],
  ['3 months', 63],
  ['6 months', 126],
  ['1 year', 252],
]

export function periodReturn(closes, n) {
  if (closes.length <= n) return null
  return closes[closes.length - 1] / closes[closes.length - 1 - n] - 1
}

function Returns({ bars }) {
  const closes = bars.map((b) => b.c)
  return (
    <div className="returns" {...ex('returns')}>
      {PERIODS.map(([label, n]) => {
        const r = periodReturn(closes, n)
        return (
          <div key={label} className="return-cell">
            <span className="return-label">{label}</span>
            <span className={`change ${dir(r)}`}>{fmtPct(r)}</span>
          </div>
        )
      })}
    </div>
  )
}

// Plain-words reading of RSI, shared with the mascot.
export function rsiReading(r) {
  if (r == null) return null
  if (r >= 70) return 'overbought: it has risen fast and hard lately'
  if (r <= 30) return 'oversold: it has fallen fast and hard lately'
  if (r >= 55) return 'leaning strong'
  if (r <= 45) return 'leaning weak'
  return 'neutral'
}

// Trendlyne-style technicals, each with a plain-words reading. Describes,
// never recommends -- same rule as the rest of the app.
function Technicals({ bars }) {
  const closes = bars.map((b) => b.c)
  const last = closes[closes.length - 1]
  const s50 = sma(closes, 50).at(-1)
  const s200 = sma(closes, 200).at(-1)
  const r = rsi(closes)
  const rows = [
    r != null && {
      label: 'RSI (14 day)',
      explain: 'rsi',
      value: r.toFixed(0),
      read: rsiReading(r),
      loud: r >= 70 || r <= 30,
    },
    s50 != null && {
      label: 'vs 50-day average',
      explain: 'vs-avg',
      value: fmtPct(last / s50 - 1),
      read: last >= s50 ? 'above it: short-term trend is up' : 'below it: short-term trend is down',
    },
    s200 != null && {
      label: 'vs 200-day average',
      explain: 'vs-avg',
      value: fmtPct(last / s200 - 1),
      read: last >= s200 ? 'above it: long-term trend is up' : 'below it: long-term trend is down',
    },
    s50 != null &&
      s200 != null && {
        label: '50d vs 200d average',
        explain: 'cross',
        value: s50 >= s200 ? 'golden ✨' : 'death 🥀',
        read:
          s50 >= s200
            ? 'golden cross zone: the short-term average is above the long-term one'
            : 'death cross zone: the short-term average is below the long-term one',
      },
  ].filter(Boolean)
  if (!rows.length) return <p className="empty">not enough history for technicals yet.</p>
  return (
    <ul className="technicals">
      {rows.map((t) => (
        <li key={t.label} className={t.loud ? 'tech-row tech-loud' : 'tech-row'} {...ex(t.explain)}>
          <span className="tech-label">{t.label}</span>
          <span className="tech-value">{t.value}</span>
          <span className="tech-read">{t.read}</span>
        </li>
      ))}
    </ul>
  )
}


// ── Stock page (Groww-style), shown as a sheet over the app ───────────

function RangeBar({ low, high, value, label, explain }) {
  if (low == null || high == null || value == null || high <= low) return null
  const pos = Math.max(0, Math.min(1, (value - low) / (high - low))) * 100
  return (
    <div className="range-bar" {...ex(explain)}>
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

// Real trades happen in the user's own broker app: Signal only hands off
// to it (no keys, no orders from this site, which has no login). Links were
// checked: Zerodha's page takes the NSE ticker directly; Groww's stock pages
// need an exact name slug, so it gets Groww's search page instead.
function TradeLinks({ symbol, onPractice }) {
  if (!symbol?.endsWith('.NS')) return null
  const t = encodeURIComponent(bare(symbol))
  return (
    <div className="trade-links">
      {onPractice && (
        <button className="ack-btn trade-practice" onClick={() => onPractice(symbol)} {...ex('practice')}>
          🎀 practice trade
        </button>
      )}
      <span className="trade-label" {...ex('trade-real')}>trade for real on</span>
      <a className="trade-link" {...ex('trade-real')} href={`https://groww.in/search?q=${t}`} target="_blank" rel="noopener noreferrer">
        Groww ↗
      </a>
      <a className="trade-link" {...ex('trade-real')} href={`https://zerodha.com/markets/stocks/NSE/${t}/`} target="_blank" rel="noopener noreferrer">
        Zerodha ↗
      </a>
    </div>
  )
}

export function StockSheet({ symbol, inWatchlist, onAdd, onClose, onPractice }) {
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  const [attempt, setAttempt] = useState(0) // bumped by "try again": Yahoo fails now and then

  useEffect(() => {
    let live = true
    setData(null)
    setError(null)
    getStock(symbol)
      .then((d) => live && setData(d))
      .catch((e) => live && setError(e.message))
    return () => {
      live = false
    }
  }, [symbol, attempt])

  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose()
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="sheet-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="pane sheet" role="dialog" aria-label={`${bare(symbol)} details`}>
        <button className="chat-close sheet-close" onClick={onClose} aria-label="close">
          ×
        </button>
        {error ? (
          <div className="notice-card">
            <p className="notice-headline">🥺 couldn't load {bare(symbol)}</p>
            <p className="notice-body">the price source didn't answer this time. it usually works on a second try.</p>
            <button className="ack-btn trade-practice" onClick={() => setAttempt((a) => a + 1)}>
              🔄 try again
            </button>
          </div>
        ) : !data ? (
          <MiniLoader text={`loading ${bare(symbol)}…`} />
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
              <span className="big-price" {...ex('big-price')}>{fmtPrice(data.price)}</span>
              <span className={`change ${dir(data.pct_change)}`} {...ex('pct-day')}>{fmtPct(data.pct_change)} today</span>
              <span className={`badge badge-${data.staleness}`} {...ex(`badge-${data.staleness}`)}>{data.staleness === 'closed' ? '🌙 last close' : data.staleness}</span>
            </div>
            <TradeLinks symbol={data.symbol} onPractice={onPractice} />

            <PriceChart bars={data.bars} />

            <h3 className="sheet-sub" {...ex('returns')}>📅 returns</h3>
            <Returns bars={data.bars} />

            <div className="stat-grid">
              <RangeBar low={data.day_low} high={data.day_high} value={data.price} label="today's range" explain="day-range" />
              <RangeBar low={data.week52_low} high={data.week52_high} value={data.price} label="52-week range" explain="52w-range" />
            </div>

            <dl className="stat-list">
              <div {...ex('prev-close')}>
                <dt>previous close</dt>
                <dd>{fmtPrice(data.prev_close)}</dd>
              </div>
              <div {...ex('volume')}>
                <dt>volume</dt>
                <dd>{fmtNum(data.volume)}</dd>
              </div>
              <div {...ex('avg-volume')}>
                <dt>avg volume (20d)</dt>
                <dd>{fmtNum(data.avg_volume_20d)}</dd>
              </div>
              <div {...ex('delivery')}>
                <dt>delivery %</dt>
                <dd>{data.deliv_pct != null ? `${data.deliv_pct.toFixed(1)}%` : '—'}</dd>
              </div>
              <div {...ex('trades')}>
                <dt>trades</dt>
                <dd>{fmtNum(data.total_trades)}</dd>
              </div>
              <div {...ex('52w-high')}>
                <dt>52-week high</dt>
                <dd>{fmtPrice(data.week52_high)}</dd>
              </div>
            </dl>

            <h3 className="sheet-sub" {...ex('rsi')}>🔮 technicals</h3>
            <Technicals bars={data.bars} />
            <p className="tech-note">readings describe the chart, they aren't advice to buy or sell.</p>

            <StockNews symbol={data.symbol} />

            <h3 className="sheet-sub" {...ex('alerts')}>🔔 recent alerts</h3>
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
