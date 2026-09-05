import { useEffect, useState, useCallback } from 'react'
import { getWatchlist, addSymbol, removeSymbol, getFeed, ackSymbol } from './api'

const POLL_MS = 15000

const STALENESS_LABEL = {
  live: '✅ LIVE',
  delayed: '⏳ DELAYED',
  stale: '😴 STALE',
  unknown: '❓ UNKNOWN',
}

const EVENT_EMOJI = {
  RESIDUAL_MOVE: '🚀',
  DELIVERY_CONVICTION: '💰',
  BLOCK_TRADE: '🐋',
  ANNOUNCEMENT: '📣',
  SURVEILLANCE: '🚨',
  RANGE_BREAK: '📈',
  DATA_STALE: '💤',
}

function StalenessBadge({ tier }) {
  return <span className={`badge badge-${tier}`}>{STALENESS_LABEL[tier] || tier}</span>
}

function formatTime(iso) {
  if (!iso) return '--'
  return new Date(iso).toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    hour: '2-digit',
    minute: '2-digit',
    day: '2-digit',
    month: 'short',
  })
}

function formatPct(pct) {
  if (pct === null || pct === undefined) return null
  const sign = pct >= 0 ? '+' : ''
  return `${sign}${(pct * 100).toFixed(1)}%`
}

function Mascot() {
  return (
    <svg width="110" height="124" viewBox="0 0 150 170" className="mascot">
      <ellipse cx="75" cy="158" rx="34" ry="7" fill="#f5b8d6" opacity="0.5" />
      <g transform="rotate(-8 75 85)">
        <path
          d="M52 55 C30 60 20 90 32 112 C38 122 50 118 50 105 C44 92 46 70 58 58 Z"
          fill="#ff8fc4"
        />
        <path
          d="M98 55 C120 60 130 90 118 112 C112 122 100 118 100 105 C106 92 104 70 92 58 Z"
          fill="#ff8fc4"
        />
        <ellipse cx="55" cy="140" rx="10" ry="16" fill="#b58af0" transform="rotate(30 55 140)" />
        <ellipse cx="98" cy="142" rx="10" ry="16" fill="#b58af0" transform="rotate(-18 98 142)" />
        <ellipse cx="48" cy="153" rx="9" ry="6" fill="#5c3350" />
        <ellipse cx="108" cy="150" rx="9" ry="6" fill="#5c3350" />
        <rect x="46" y="88" width="58" height="52" rx="26" fill="#c9a8f5" />
        <path
          d="M62 100 l8 8 6 -6 8 10 6 -8"
          stroke="#ffffff"
          strokeWidth="3"
          fill="none"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <ellipse cx="52" cy="118" rx="9" ry="16" fill="#c9a8f5" transform="rotate(18 52 118)" />
        <ellipse cx="98" cy="118" rx="9" ry="16" fill="#c9a8f5" transform="rotate(-18 98 118)" />
        <g transform="translate(60 108)">
          <ellipse cx="15" cy="18" rx="16" ry="13" fill="#ffffff" />
          <circle cx="15" cy="4" r="11" fill="#ffffff" />
          <path d="M6 -2 L9 6 L14 -1 Z" fill="#ffffff" />
          <path d="M24 -2 L21 6 L16 -1 Z" fill="#ffffff" />
          <circle cx="11" cy="4" r="1.4" fill="#5c3350" />
          <circle cx="19" cy="4" r="1.4" fill="#5c3350" />
          <path d="M12 8 Q15 10 18 8" stroke="#5c3350" strokeWidth="1.2" fill="none" strokeLinecap="round" />
        </g>
        <circle cx="75" cy="62" r="30" fill="#ffe3cf" />
        <path d="M46 55 C50 30 100 30 104 55 C96 44 54 44 46 55 Z" fill="#ff8fc4" />
        <circle cx="64" cy="63" r="3" fill="#5c3350" />
        <circle cx="86" cy="63" r="3" fill="#5c3350" />
        <circle cx="58" cy="72" r="5" fill="#ff9fc9" opacity="0.7" />
        <circle cx="92" cy="72" r="5" fill="#ff9fc9" opacity="0.7" />
        <path d="M68 76 Q75 81 82 76" stroke="#5c3350" strokeWidth="2" fill="none" strokeLinecap="round" />
      </g>
    </svg>
  )
}

function WatchlistRow({ row, onRemove }) {
  const pct = formatPct(row.pct_change)
  const emoji = row.pct_change == null ? '' : row.pct_change >= 0 ? '🚀' : '😢'
  return (
    <li className="watch-row">
      <div className="watch-row-main">
        <span className="symbol">{row.symbol}</span>
        {row.price != null ? (
          <span className="price">₹{row.price.toFixed(2)}</span>
        ) : (
          <span className="price price-error" title={row.error}>
            no data
          </span>
        )}
        {pct && (
          <span className={`change ${row.pct_change >= 0 ? 'up' : 'down'}`}>
            {emoji} {pct}
          </span>
        )}
      </div>
      <div className="watch-row-meta">
        <StalenessBadge tier={row.staleness} />
        <button className="remove-btn" onClick={() => onRemove(row.symbol)} title="Remove from watchlist">
          ×
        </button>
      </div>
    </li>
  )
}

function EventCard({ event, onAck }) {
  const [open, setOpen] = useState(false)
  const emoji = EVENT_EMOJI[event.type] || '✨'
  return (
    <li className="event-card">
      <div className="event-header">
        <span className="event-symbol">{event.symbol}</span>
        <span className="event-type-chip">
          {emoji} {event.type}
        </span>
        <span className="event-score">{event.score.toFixed(1)}σ</span>
      </div>
      <p className="event-reason">{event.reason}</p>
      <div className="event-footer">
        <span className="event-time">{formatTime(event.occurred_at)}</span>
        <button className="link-btn" onClick={() => setOpen((v) => !v)}>
          {open ? '🙈 hide why' : '🔍 why?'}
        </button>
        <button className="ack-btn" onClick={() => onAck(event)}>
          💗 seen it!
        </button>
      </div>
      {open && <pre className="evidence">{JSON.stringify(event.evidence, null, 2)}</pre>}
    </li>
  )
}

const LENSES = [
  { key: 'since_last', label: 'since last ✨' },
  { key: 'today', label: 'today' },
  { key: 'since_added', label: 'since added' },
]

export default function App() {
  const [watchlist, setWatchlist] = useState([])
  const [feed, setFeed] = useState([])
  const [lens, setLens] = useState('since_last')
  const [newSymbol, setNewSymbol] = useState('')
  const [error, setError] = useState(null)

  const refreshWatchlist = useCallback(async () => {
    try {
      const data = await getWatchlist()
      setWatchlist(data.watchlist)
      setError(null)
    } catch (err) {
      setError(err.message)
    }
  }, [])

  const refreshFeed = useCallback(async (currentLens) => {
    try {
      const data = await getFeed(currentLens)
      setFeed(data.events)
    } catch (err) {
      setError(err.message)
    }
  }, [])

  useEffect(() => {
    refreshWatchlist()
  }, [refreshWatchlist])

  useEffect(() => {
    refreshFeed(lens)
  }, [lens, refreshFeed])

  // Single poll loop for both panes -- no WebSockets/SSE for v1.
  useEffect(() => {
    const id = setInterval(() => {
      refreshWatchlist()
      refreshFeed(lens)
    }, POLL_MS)
    return () => clearInterval(id)
  }, [lens, refreshWatchlist, refreshFeed])

  const handleAdd = async (e) => {
    e.preventDefault()
    const symbol = newSymbol.trim().toUpperCase()
    if (!symbol) return
    try {
      await addSymbol(symbol)
      setNewSymbol('')
      refreshWatchlist()
    } catch (err) {
      setError(err.message)
    }
  }

  const handleRemove = async (symbol) => {
    try {
      await removeSymbol(symbol)
      refreshWatchlist()
    } catch (err) {
      setError(err.message)
    }
  }

  // Ack is per-symbol, explicit action only -- never fires on page load.
  const handleAck = async (event) => {
    try {
      await ackSymbol(event.symbol, event.occurred_at)
      refreshFeed(lens)
    } catch (err) {
      setError(err.message)
    }
  }

  return (
    <div className="app">
      <header className="app-header">
        <div className="app-header-text">
          <h1>Signal 💗</h1>
          <p className="tagline">what changed for your girlies (the stocks) today ✨</p>
        </div>
        <Mascot />
      </header>

      {error && <div className="error-banner">{error}</div>}

      <main className="layout">
        <section className="pane watchlist-pane">
          <h2>🐾 my watchlist</h2>
          <form className="add-form" onSubmit={handleAdd}>
            <input
              value={newSymbol}
              onChange={(e) => setNewSymbol(e.target.value)}
              placeholder="add a stock... 🔍"
            />
            <button type="submit">+ add</button>
          </form>
          {watchlist.length === 0 ? (
            <p className="empty">no symbols yet -- add one above! 🎀</p>
          ) : (
            <ul className="watch-list">
              {watchlist.map((row) => (
                <WatchlistRow key={row.symbol} row={row} onRemove={handleRemove} />
              ))}
            </ul>
          )}
        </section>

        <section className="pane inbox-pane">
          <div className="inbox-header">
            <h2>💌 since you last peeked</h2>
            <div className="lens-switcher">
              {LENSES.map((l) => (
                <button
                  key={l.key}
                  className={lens === l.key ? 'lens-btn active' : 'lens-btn'}
                  onClick={() => setLens(l.key)}
                >
                  {l.label}
                </button>
              ))}
            </div>
          </div>
          {feed.length === 0 ? (
            <p className="empty">nothing unexplained right now 🌸</p>
          ) : (
            <ul className="event-list">
              {feed.map((event) => (
                <EventCard key={event.fingerprint} event={event} onAck={handleAck} />
              ))}
            </ul>
          )}
        </section>
      </main>
    </div>
  )
}
