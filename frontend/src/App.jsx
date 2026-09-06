import { useEffect, useState, useCallback } from 'react'
import { getWatchlist, addSymbol, removeSymbol, getChanged, getQuietLog, ackSymbol } from './api'

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

const MASCOT_SRC = {
  happy: '/mascot/mascot-happy.jpg',
  neutral: '/mascot/mascot-neutral.jpg',
  confused: '/mascot/mascot-confused.jpg',
  cat: '/mascot/mascot-cat.jpg',
}

function Mascot({ mood }) {
  return (
    <div className="mascot-frame">
      <img src={MASCOT_SRC[mood] || MASCOT_SRC.neutral} alt="Signal mascot" />
    </div>
  )
}

// happy when most tracked stocks are up, confused when a feed has gone
// stale (we'd rather flag that than show a wrong price), cat while the
// watchlist is still empty, neutral otherwise.
function moodFor(watchlist) {
  if (watchlist.length === 0) return 'cat'
  if (watchlist.some((r) => r.staleness === 'stale')) return 'confused'
  const up = watchlist.filter((r) => r.pct_change > 0).length
  return up > watchlist.length / 2 ? 'happy' : 'neutral'
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

const FIELD_LABEL = {
  volatility_regime: 'volatility',
  liquidity_regime: 'liquidity',
  beta_to_index: 'market sensitivity (beta)',
  range_position: 'position in its recent range',
}

const FIELD_EMOJI = {
  volatility_regime: '🌊',
  liquidity_regime: '💧',
  beta_to_index: '🎯',
  range_position: '📍',
}

// A Statement is a net state diff (what_changed), not a raw event -- see
// SPEC.md. It carries no occurred_at (it's a diff between two snapshots,
// not a point in time), so "seen it" just advances the symbol's
// watermark to right now.
function StatementCard({ statement, onAck }) {
  const [open, setOpen] = useState(false)
  const emoji = FIELD_EMOJI[statement.field] || '✨'
  return (
    <li className="event-card">
      <div className="event-header">
        <span className="event-symbol">{statement.symbol}</span>
        <span className="event-type-chip">
          {emoji} {FIELD_LABEL[statement.field] || statement.field}
        </span>
      </div>
      <div className="speech-bubble">
        <span className="speech-bubble-tag">the tea</span>
        <p className="event-reason">{statement.reason}</p>
      </div>
      <div className="event-footer">
        <span className="event-time">since {statement.since}</span>
        <button className="link-btn" onClick={() => setOpen((v) => !v)}>
          {open ? '🙈 hide why' : '🔍 why?'}
        </button>
        <button className="ack-btn" onClick={() => onAck(statement.symbol)}>
          💗 seen it!
        </button>
      </div>
      {open && <pre className="evidence">{JSON.stringify(statement.evidence, null, 2)}</pre>}
    </li>
  )
}

// Read-only -- an event that fired and reverted before it changed
// anything lasting. Nothing to ack; it never made it into the main view.
function QuietLogCard({ event }) {
  const emoji = EVENT_EMOJI[event.type] || '✨'
  return (
    <li className="event-card quiet-card">
      <div className="event-header">
        <span className="event-symbol">{event.symbol}</span>
        <span className="event-type-chip">
          {emoji} {event.type}
        </span>
        <span className="event-score">{event.score.toFixed(1)}σ</span>
      </div>
      <p className="event-reason quiet-reason">{event.reason}</p>
      <div className="event-footer">
        <span className="event-time">{formatTime(event.occurred_at)} · reverted, didn't last</span>
      </div>
    </li>
  )
}

const INBOX_TABS = [
  { key: 'changed', label: 'since last ✨' },
  { key: 'quiet', label: 'quiet log' },
]

export default function App() {
  const [watchlist, setWatchlist] = useState([])
  const [changed, setChanged] = useState(null)
  const [quietLog, setQuietLog] = useState(null)
  const [inboxTab, setInboxTab] = useState('changed')
  const [newSymbol, setNewSymbol] = useState('')
  const [error, setError] = useState(null)
  const [now, setNow] = useState(() => new Date())

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 30000)
    return () => clearInterval(id)
  }, [])

  const mood = moodFor(watchlist)
  const staleCount = watchlist.filter((r) => r.staleness === 'stale').length
  const delayedCount = watchlist.filter((r) => r.staleness === 'delayed').length
  const feedLabel = staleCount > 0
    ? `${staleCount} feed${staleCount > 1 ? 's' : ''} stale`
    : delayedCount > 0
      ? `${delayedCount} feed${delayedCount > 1 ? 's' : ''} delayed`
      : 'live'

  const refreshWatchlist = useCallback(async () => {
    try {
      const data = await getWatchlist()
      setWatchlist(data.watchlist)
      setError(null)
    } catch (err) {
      setError(err.message)
    }
  }, [])

  const refreshChanged = useCallback(async () => {
    try {
      setChanged(await getChanged())
    } catch (err) {
      setError(err.message)
    }
  }, [])

  const refreshQuietLog = useCallback(async () => {
    try {
      setQuietLog(await getQuietLog())
    } catch (err) {
      setError(err.message)
    }
  }, [])

  // Any request that lacks the signal_user_id cookie makes get_user_id()
  // mint a fresh anonymous one -- and a browser's cookie-jar write from
  // one response isn't guaranteed to be visible to a fetch() fired in
  // the same tick as that response resolves. Firing these three
  // concurrently, even back-to-back right after a cookie-establishing
  // call, could still race: one of the three would occasionally go out
  // cookie-less, mint its own identity, and whichever Set-Cookie landed
  // last became the one the browser kept -- silently orphaning
  // whatever the others had just written. Strictly sequencing them
  // (never firing the next until the previous has actually resolved)
  // removes the race instead of just narrowing it.
  const refreshAll = useCallback(async () => {
    await refreshWatchlist()
    await refreshChanged()
    await refreshQuietLog()
  }, [refreshWatchlist, refreshChanged, refreshQuietLog])

  useEffect(() => {
    refreshAll()
  }, [refreshAll])

  // Single poll loop for both panes -- no WebSockets/SSE for v1.
  useEffect(() => {
    const id = setInterval(refreshAll, POLL_MS)
    return () => clearInterval(id)
  }, [refreshAll])

  const handleAdd = async (e) => {
    e.preventDefault()
    const symbol = newSymbol.trim().toUpperCase()
    if (!symbol) return
    try {
      await addSymbol(symbol)
      setNewSymbol('')
      await refreshAll()
    } catch (err) {
      setError(err.message)
    }
  }

  const handleRemove = async (symbol) => {
    try {
      await removeSymbol(symbol)
      await refreshAll()
    } catch (err) {
      setError(err.message)
    }
  }

  // Ack is per-symbol, explicit action only -- never fires on page load.
  // A Statement has no occurred_at (it's a diff, not a point in time),
  // so acking one advances that symbol's watermark to right now.
  const handleAck = async (symbol) => {
    try {
      await ackSymbol(symbol, new Date().toISOString())
      await refreshChanged()
    } catch (err) {
      setError(err.message)
    }
  }

  return (
    <div className="app">
      <header className="app-header">
        <div className="wordmark">
          <span className="l-s">S</span>
          <span className="l-i">i</span>
          <span className="l-g">g</span>
          <span className="l-n">n</span>
          <span className="l-a">a</span>
          <span className="l-l">l</span>
        </div>
        <div className="header-right">
          <div className="header-status">
            <div className="clock">
              {now.toLocaleString('en-IN', {
                timeZone: 'Asia/Kolkata',
                day: '2-digit',
                month: 'short',
                hour: '2-digit',
                minute: '2-digit',
              })}
            </div>
            <div className="feed-label">{feedLabel}</div>
          </div>
          <Mascot mood={mood} />
        </div>
      </header>
      <p className="tagline">what changed for your girlies (the stocks) today ✨</p>

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
              {INBOX_TABS.map((t) => (
                <button
                  key={t.key}
                  className={inboxTab === t.key ? 'lens-btn active' : 'lens-btn'}
                  onClick={() => setInboxTab(t.key)}
                >
                  {t.label}
                </button>
              ))}
            </div>
          </div>

          {inboxTab === 'changed' ? (
            <>
              <p className="inbox-subtitle">what_changed(t0, now) -- not a log of everything that happened</p>
              {!changed ? null : changed.statements.length > 0 ? (
                <ul className="event-list">
                  {changed.statements.map((s) => (
                    <StatementCard key={`${s.symbol}-${s.field}`} statement={s} onAck={handleAck} />
                  ))}
                </ul>
              ) : (
                <div className="notice-card">
                  <p className="notice-headline">
                    {changed.asserted_empty ? '✨ nothing changed' : '📊 still learning your stocks'}
                  </p>
                  <p className="notice-body">{changed.message}</p>
                  {changed.insufficient_history?.length > 0 && (
                    <ul className="insufficient-list">
                      {changed.insufficient_history.map((h) => (
                        <li key={h.symbol}>
                          <span className="symbol">{h.symbol}</span>: {h.days_available}/{h.days_needed} days of price
                          history so far
                        </li>
                      ))}
                    </ul>
                  )}
                  <p className="notice-asof">data current as of {changed.as_of}</p>
                </div>
              )}
            </>
          ) : (
            <>
              <p className="inbox-subtitle">alerts that fired, then reverted before they changed anything lasting</p>
              {!quietLog ? null : quietLog.events.length > 0 ? (
                <ul className="event-list">
                  {quietLog.events.map((e) => (
                    <QuietLogCard key={`${e.symbol}-${e.type}-${e.occurred_at}`} event={e} />
                  ))}
                </ul>
              ) : (
                <div className="notice-card">
                  <p className="notice-headline">🌸 quiet log is empty</p>
                  <p className="notice-body">{quietLog.message}</p>
                </div>
              )}
            </>
          )}
        </section>
      </main>
    </div>
  )
}
