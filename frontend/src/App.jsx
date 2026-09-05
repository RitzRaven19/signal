import { useEffect, useState, useCallback } from 'react'
import { getWatchlist, addSymbol, removeSymbol, getFeed, ackSymbol } from './api'

const POLL_MS = 15000

const STALENESS_LABEL = {
  live: 'LIVE',
  delayed: 'DELAYED',
  stale: 'STALE',
  unknown: 'UNKNOWN',
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

function WatchlistRow({ row, onRemove }) {
  const pct = formatPct(row.pct_change)
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
        {pct && <span className={`change ${row.pct_change >= 0 ? 'up' : 'down'}`}>{pct}</span>}
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
  return (
    <li className="event-card">
      <div className="event-header">
        <span className="event-symbol">{event.symbol}</span>
        <span className="event-type-chip">{event.type}</span>
        <span className="event-score">{event.score.toFixed(1)}σ</span>
      </div>
      <p className="event-reason">{event.reason}</p>
      <div className="event-footer">
        <span className="event-time">{formatTime(event.occurred_at)}</span>
        <button className="link-btn" onClick={() => setOpen((v) => !v)}>
          {open ? 'hide why' : 'why?'}
        </button>
        <button className="ack-btn" onClick={() => onAck(event)}>
          Mark seen
        </button>
      </div>
      {open && <pre className="evidence">{JSON.stringify(event.evidence, null, 2)}</pre>}
    </li>
  )
}

const LENSES = [
  { key: 'since_last', label: 'Since last visit' },
  { key: 'today', label: 'Today' },
  { key: 'since_added', label: 'Since I added it' },
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
        <h1>Signal</h1>
        <p className="tagline">What changed for the company, not the screen.</p>
      </header>

      {error && <div className="error-banner">{error}</div>}

      <main className="layout">
        <section className="pane watchlist-pane">
          <h2>Watchlist</h2>
          <form className="add-form" onSubmit={handleAdd}>
            <input
              value={newSymbol}
              onChange={(e) => setNewSymbol(e.target.value)}
              placeholder="e.g. RELIANCE.NS"
            />
            <button type="submit">Add</button>
          </form>
          {watchlist.length === 0 ? (
            <p className="empty">No symbols yet -- add one above.</p>
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
            <h2>Since you last checked</h2>
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
            <p className="empty">Nothing unexplained right now.</p>
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
