import { Fragment, useEffect, useState, useCallback, useRef } from 'react'
import { getWatchlist, addSymbol, removeSymbol, getChanged, getQuietLog, ackSymbol } from './api'
import { replyAsync, QUICK_REPLIES } from './mascotChat'
import { MarketView, ScansView, StockSheet, SymbolSearch } from './market'
import { FundSheet, FundsView } from './funds'
import { ShopView } from './shop'
import { InstallButton, Tour, useTour } from './tour'
import { StartHere, StarterStocks, TodaySnapshot } from './home'
import { LearnBubble, LearnToggle, ex, useLearnMode } from './explain'
import { GroovyText } from './groovy'

const POLL_MS = 15000

const STALENESS_LABEL = {
  live: '✅ LIVE',
  delayed: '⏳ DELAYED',
  stale: '😴 STALE',
  closed: '🌙 MARKET CLOSED',
  unknown: '❓ UNKNOWN',
}

// One definition, shared by the mood, the bubble, the header and at-a-glance,
// so she can never say "all feeds ok" next to "4 feeds lagging". A
// market-closed price is the correct last close, not a lagging one.
const isLagging = (r) => r.price == null || r.staleness === 'stale' || r.staleness === 'unknown'

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
  return <span className={`badge badge-${tier}`} {...ex(`badge-${tier}`)}>{STALENESS_LABEL[tier] || tier}</span>
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

// The mascot art, plus where each image's open eyes are (source pixels:
// centre x, centre y, width, height) and the skin tone around them. The
// art is never altered: blinking is skin-toned eyelids positioned over the
// eyes that close for a split second. Happy's right eye is already a
// wink, so only her open eye blinks.
const MASCOT_ART = {
  happy: { src: '/mascot/mascot-happy.jpg', w: 736, h: 736, skin: '#fde6df', eyes: [[298, 232, 70, 80]] },
  neutral: { src: '/mascot/mascot-neutral.jpg', w: 736, h: 736, skin: '#fde3dc', eyes: [[315, 318, 72, 84], [440, 340, 72, 84]] },
  confused: { src: '/mascot/mascot-confused.jpg', w: 736, h: 736, skin: '#fde4df', eyes: [[310, 340, 72, 86], [437, 318, 68, 84]] },
  cat: { src: '/mascot/mascot-cat.jpg', w: 736, h: 1104, skin: '#fbdcd5', eyes: [[268, 632, 92, 100], [472, 648, 92, 100]] },
}

// Eyelid box as % of the displayed (square, object-fit: cover) image.
// A taller-than-wide image is cropped equally top and bottom.
function lidStyle(art, [cx, cy, w, h]) {
  const side = Math.min(art.w, art.h)
  const offX = (art.w - side) / 2
  const offY = (art.h - side) / 2
  return {
    left: `${((cx - w / 2 - offX) / side) * 100}%`,
    top: `${((cy - h / 2 - offY) / side) * 100}%`,
    width: `${(w / side) * 100}%`,
    height: `${(h / side) * 100}%`,
    '--skin': art.skin,
  }
}

// `key={mood}` remounts the art when her mood changes, so the
// mascot-swap fade replays instead of the image snapping over.
function Mascot({ mood, hopping = false, talking = false }) {
  const art = MASCOT_ART[mood] || MASCOT_ART.neutral
  const cls = ['mascot-frame', hopping && 'hopping', talking && 'talking'].filter(Boolean).join(' ')
  return (
    <div className={cls}>
      <div className="mascot-art" key={mood}>
        <img src={art.src} alt={`Signal mascot, ${mood}`} />
        {art.eyes.map((eye, i) => (
          <span key={i} className="mascot-lid" style={lidStyle(art, eye)} aria-hidden="true" />
        ))}
      </div>
      {mood === 'happy' && (
        <span className="mascot-sparkles" aria-hidden="true">
          <i>✦</i>
          <i>✦</i>
          <i>✧</i>
        </span>
      )}
      {mood === 'cat' && (
        <span className="mascot-hearts" aria-hidden="true">
          <i>♥</i>
          <i>♥</i>
        </span>
      )}
    </div>
  )
}

// The loading screen: it fills the window on its own while the first
// fetch is in flight, and the bunny runs the bar edge to edge. Nothing
// else renders until it's done.
function LoadingCard({ count }) {
  return (
    <div className="loading-screen" role="status" aria-live="polite">
      <div className="loading-title">loading</div>
      <div className="loading-track">
        <div className="loading-fill" />
        <div className="loading-runner">
          <div className="bunny">
            <span className="ear ear-l" />
            <span className="ear ear-r" />
            <span className="bunny-face">• ᴗ •</span>
          </div>
        </div>
      </div>
      <div className="loading-caption">
        {count ? `checking on your ${count} friends…` : 'checking on your friends…'}
      </div>
    </div>
  )
}

// happy when most tracked stocks are up, confused when a feed has gone
// stale (we'd rather flag that than show a wrong price), cat while the
// watchlist is still empty, neutral otherwise.
function moodFor(watchlist) {
  if (watchlist.length === 0) return 'cat'
  if (watchlist.some(isLagging)) return 'confused'
  const up = watchlist.filter((r) => r.pct_change > 0).length
  return up > watchlist.length / 2 ? 'happy' : 'neutral'
}

function WatchlistRow({ row, onRemove, onOpen }) {
  const pct = formatPct(row.pct_change)
  const dir = row.pct_change == null ? 'flat' : row.pct_change >= 0 ? 'up' : 'down'
  return (
    <li className="watch-row">
      <button className="watch-row-id row-open" onClick={() => onOpen(row.symbol)} title={`open ${row.symbol}`}>
        <span className="symbol">{row.symbol.replace(/\.NS$/, '')}</span>
        <StalenessBadge tier={row.staleness} />
      </button>
      <div className="watch-row-quote">
        {row.price != null ? (
          <span className="price" {...ex('watch-price')}>₹{row.price.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
        ) : (
          <span className="price price-error" title={row.error}>
            no data
          </span>
        )}
        <span className={`change ${dir}`} {...ex('pct-day')}>{pct ?? '—'}</span>
      </div>
      <button className="remove-btn" onClick={() => onRemove(row.symbol)} title={`Remove ${row.symbol}`}>
        ×
      </button>
    </li>
  )
}

// The mockup's "feeling good" card, driven by the real watchlist. Clicking
// her toggles the pixel speech bubble with the day's one-line summary.
function MoodCard({ watchlist, changed, mood, actions }) {
  const [open, setOpen] = useState(false)
  const [hopping, setHopping] = useState(false)
  const [talking, setTalking] = useState(false)
  const talkTimer = useRef(null)
  const speak = () => {
    setTalking(true)
    clearTimeout(talkTimer.current)
    talkTimer.current = setTimeout(() => setTalking(false), 1400)
  }
  useEffect(() => () => clearTimeout(talkTimer.current), [])
  const tap = () => {
    setOpen((v) => !v)
    setHopping(true)
  }
  const up = watchlist.filter((r) => r.pct_change > 0).length
  const down = watchlist.filter((r) => r.pct_change < 0).length
  const stale = watchlist.filter(isLagging).length
  const closed = watchlist.some((r) => r.staleness === 'closed')
  const n = watchlist.length

  const label = { happy: 'feeling good', neutral: 'all quiet', confused: 'signal unclear', cat: 'hi bestie' }[mood]
  const line =
    n === 0
      ? "add a stock and i'll start keeping an eye on it for you."
      : stale > 0
        ? `a feed is lagging on ${stale} of your ${n}. i'd rather flag it than guess.`
        : up > n / 2
          ? `${up} of your ${n} ${closed ? 'closed up' : 'are up today'}.`
          : `${up} up, ${down} down${closed ? ' at the close' : ''}. nothing loud yet.`
  const bubble =
    n === 0
      ? 'NOTHING TO WATCH\nYET. ADD ONE!'
      : `${up} UP · ${down} DOWN\n${stale ? `${stale} FEED${stale > 1 ? 'S' : ''} LAGGING` : closed ? 'MARKET CLOSED' : 'ALL FEEDS OK'}`

  return (
    <section className="pane mood-card">
      <div className="mood-top">
        <button
          className="mood-mascot"
          {...ex('mascot')}
          onClick={tap}
          onAnimationEnd={(e) => e.animationName === 'hop' && setHopping(false)}
          title="tap her for today's summary"
        >
          <Mascot mood={mood} hopping={hopping} talking={talking} />
        </button>
        <div className="mood-body">
          <span className="mood-label">{label}</span>
          <p className="mood-line">{line}</p>
          {open ? (
            <div className="pixel-bubble">{bubble}</div>
          ) : (
            <p className="mood-hint">tap her for today's summary</p>
          )}
        </div>
      </div>
      <MascotChat watchlist={watchlist} changed={changed} mood={mood} onReply={speak} actions={actions} />
    </section>
  )
}

// Talk to her (brain in mascotChat.js) -- free, no model; every answer is
// read off the same data as the page. She can also act: add/remove a
// stock or open its page. Tickers and funds she names are tappable, and
// her follow-up chips change with what you just asked.
// Chat history lives in this browser's localStorage -- the same scope as
// the signal_user_id cookie that identifies the watchlist. Each message is
// timestamped: her answers describe the data at the moment she gave them,
// so old ones are shown under their day rather than passing as current.
const CHAT_KEY = 'signal-chat-v1'
const CHAT_MAX = 200
const greeting = () => ({
  from: 'her',
  text: 'hiii! ask me about the market, any stock or mutual fund, what a word like RSI means, or tell me "add TCS" and i\'ll do it.',
  at: new Date().toISOString(),
})

function loadChat() {
  try {
    const saved = JSON.parse(localStorage.getItem(CHAT_KEY))
    if (Array.isArray(saved) && saved.length) return saved
  } catch {
    // storage blocked or corrupt -- start fresh
  }
  return [greeting()]
}

const dayLabel = (iso) => {
  const d = new Date(iso)
  const today = new Date()
  const yesterday = new Date(today.getTime() - 86400000)
  const same = (a, b) => a.toDateString() === b.toDateString()
  if (same(d, today)) return 'today'
  if (same(d, yesterday)) return 'yesterday'
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })
}
const timeLabel = (iso) =>
  new Date(iso).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' })

// Her text with the tickers/funds she named turned into buttons.
function ChatText({ message, actions }) {
  const links = message.links || []
  if (!links.length) return message.text
  const byLabel = new Map(links.map((l) => [l.label, l]))
  const pattern = new RegExp(
    `(${[...byLabel.keys()].sort((a, b) => b.length - a.length).map((l) => l.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`,
  )
  return message.text.split(pattern).map((part, i) => {
    const l = byLabel.get(part)
    if (!l) return part
    return (
      <button key={i} className="chat-link" onClick={() => (l.fund ? actions.openFund(l.fund) : actions.open(l.symbol))}>
        {part}
      </button>
    )
  })
}

function MascotChat({ watchlist, changed, mood, onReply, actions }) {
  const [chatOpen, setChatOpen] = useState(false)
  const [messages, setMessages] = useState(loadChat)
  const [draft, setDraft] = useState('')
  const [thinking, setThinking] = useState(false)
  const listRef = useRef(null)

  useEffect(() => {
    try {
      localStorage.setItem(CHAT_KEY, JSON.stringify(messages.slice(-CHAT_MAX)))
    } catch {
      // storage full or blocked -- the chat still works, it just won't persist
    }
  }, [messages])

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' })
  }, [messages, chatOpen, thinking])

  // Market and stock answers fetch data, so she shows a typing bubble
  // until the reply is ready; watchlist answers come back instantly.
  const ask = async (text) => {
    if (!text.trim() || thinking) return
    setMessages((m) => [...m, { from: 'you', text, at: new Date().toISOString() }].slice(-CHAT_MAX))
    setDraft('')
    setThinking(true)
    const answer = await replyAsync(text, { watchlist, changed, mood })
    setThinking(false)
    const { action, ...said } = answer
    setMessages((m) => [...m, { from: 'her', ...said, at: new Date().toISOString() }].slice(-CHAT_MAX))
    onReply()
    if (action?.type === 'add') actions.add(action.symbol)
    if (action?.type === 'remove') actions.remove(action.symbol)
    if (action?.type === 'open') actions.open(action.symbol)
  }

  // Her latest follow-ups, or the starters if she hasn't suggested any.
  const lastHer = [...messages].reverse().find((m) => m.from === 'her')
  const chips = lastHer?.chips?.length ? lastHer.chips : QUICK_REPLIES

  const clearChat = () => setMessages([greeting()])

  if (!chatOpen) {
    return (
      <button className="chat-toggle" onClick={() => setChatOpen(true)}>
        <GroovyText text="💬 talk to me" />
      </button>
    )
  }

  return (
    <div className="chat">
      <div className="chat-head">
        <span>chatting with signal</span>
        <div className="chat-head-actions">
          {messages.length > 1 && (
            <button className="chat-clear" onClick={clearChat}>
              clear
            </button>
          )}
          <button className="chat-close" onClick={() => setChatOpen(false)} aria-label="close chat">
            ×
          </button>
        </div>
      </div>
      <ul className="chat-log" ref={listRef} aria-live="polite">
        {messages.map((m, i) => {
          const day = m.at ? dayLabel(m.at) : null
          const newDay = day && (i === 0 || dayLabel(messages[i - 1].at ?? m.at) !== day)
          return (
            <Fragment key={i}>
              {newDay && <li className="chat-day">{day}</li>}
              <li className={`chat-msg from-${m.from}`}>
                {m.from === 'her' ? <ChatText message={m} actions={actions} /> : m.text}
                {m.at && <time className="chat-time">{timeLabel(m.at)}</time>}
              </li>
            </Fragment>
          )
        })}
        {thinking && (
          <li className="chat-msg from-her chat-typing" aria-label="typing">
            <span />
            <span />
            <span />
          </li>
        )}
      </ul>
      <div className="chat-chips">
        {chips.map((q) => (
          <button key={q} className="chat-chip" onClick={() => ask(q)} disabled={thinking}>
            {q}
          </button>
        ))}
      </div>
      <form
        className="chat-form"
        onSubmit={(e) => {
          e.preventDefault()
          ask(draft)
        }}
      >
        <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="ask me something…" aria-label="message" />
        <button type="submit">send</button>
      </form>
    </div>
  )
}

function AtAGlance({ watchlist, changed }) {
  const up = watchlist.filter((r) => r.pct_change > 0).length
  const lagging = watchlist.filter(isLagging).length
  const statements = changed?.statements?.length ?? 0
  const rows = [
    ['tracked', watchlist.length, 'accent'],
    ['up today', watchlist.length ? `${up} of ${watchlist.length}` : '—', 'accent'],
    ['feeds lagging', lagging, lagging ? 'muted' : 'accent'],
    ['changes to read', statements, statements ? 'accent' : 'muted'],
  ]
  return (
    <section className="pane glance" {...ex('glance')}>
      <h2 className="groovy-title"><GroovyText text={'at a glance'} /></h2>
      <ul className="glance-list">
        {rows.map(([k, v, tone]) => (
          <li key={k}>
            <span>{k}</span>
            <span className={`glance-pill ${tone}`}>{v}</span>
          </li>
        ))}
      </ul>
    </section>
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
        <span className="event-score">
          {event.score.toFixed(1)}
          {event.type === 'RESIDUAL_MOVE' ? 'σ' : '×'}
        </span>
      </div>
      <p className="event-reason quiet-reason">{event.reason}</p>
      <div className="event-footer">
        <span className="event-time">{formatTime(event.occurred_at)} · reverted, didn't last</span>
      </div>
    </li>
  )
}

const VIEWS = [
  { key: 'mine', label: '🐾 my stocks' },
  { key: 'market', label: '📈 market' },
  { key: 'scans', label: '✨ scans' },
  { key: 'funds', label: '💰 funds' },
  { key: 'practice', label: '🛍️ shop' },
]

const INBOX_TABS = [
  { key: 'changed', label: 'since last ✨' },
  { key: 'quiet', label: 'quiet log' },
]

export default function App() {
  const [watchlist, setWatchlist] = useState([])
  const [changed, setChanged] = useState(null)
  const [quietLog, setQuietLog] = useState(null)
  const [inboxTab, setInboxTab] = useState('changed')
  const [view, setView] = useState('mine')
  const [learnMode, setLearnMode] = useLearnMode()
  const [openSymbol, setOpenSymbol] = useState(null)
  const closeSheet = useCallback(() => setOpenSymbol(null), [])
  const [openFund, setOpenFund] = useState(null)
  const closeFund = useCallback(() => setOpenFund(null), [])
  const [practicePick, setPracticePick] = useState(null)
  const [shopTab, setShopTab] = useState('boutique')
  // "start here" card on the home page
  const goStart = (what) => {
    if (what === 'point') {
      setLearnMode(true)
      return
    }
    setPracticePick(null)
    setShopTab(what === 'learn' ? 'learn' : 'boutique')
    setView('practice')
  }
  const practiceTrade = (symbol) => {
    setPracticePick(symbol)
    setOpenSymbol(null)
    setView('practice')
  }
  const [error, setError] = useState(null)
  const [now, setNow] = useState(() => new Date())
  const [loaded, setLoaded] = useState(false)
  const tour = useTour(loaded)

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 30000)
    return () => clearInterval(id)
  }, [])

  const mood = moodFor(watchlist)
  const staleCount = watchlist.filter(isLagging).length
  const delayedCount = watchlist.filter((r) => r.staleness === 'delayed').length
  const allClosed = watchlist.length > 0 && watchlist.every((r) => r.staleness === 'closed')
  const feedLabel = watchlist.length === 0
    ? 'nothing tracked yet'
    : staleCount > 0
    ? `${staleCount} feed${staleCount > 1 ? 's' : ''} lagging`
    : delayedCount > 0
      ? `${delayedCount} feed${delayedCount > 1 ? 's' : ''} delayed`
      : allClosed
        ? 'market closed · last close'
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
    refreshAll().finally(() => setLoaded(true))
  }, [refreshAll])

  // Single poll loop for both panes -- no WebSockets/SSE for v1.
  useEffect(() => {
    const id = setInterval(refreshAll, POLL_MS)
    return () => clearInterval(id)
  }, [refreshAll])

  const handleAdd = async (symbol) => {
    if (!symbol) return
    try {
      await addSymbol(symbol)
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

  // What the mascot can do when asked ("add TCS", "open INFY", tapping a ticker).
  const chatActions = { add: handleAdd, remove: handleRemove, open: setOpenSymbol, openFund: setOpenFund }

  // Until the first fetch lands, the loading screen is the whole page.
  if (!loaded) return <LoadingCard count={watchlist.length} />

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
          <InstallButton />
          <button className="learn-toggle tour-btn" onClick={tour.start} title="take the tour again" aria-label="take the tour again">
            ❓
          </button>
          <LearnToggle on={learnMode} setOn={setLearnMode} />
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
        </div>
      </header>
      <p className="tagline groovy-tagline">
        <GroovyText text="what changed for your girlies (the stocks) today ✨" />
      </p>

      {error && <div className="error-banner">{error}</div>}

      <nav className="lens-switcher view-switcher" aria-label="views">
        {VIEWS.map((v) => (
          <button key={v.key} className={view === v.key ? 'lens-btn active' : 'lens-btn'} onClick={() => setView(v.key)}>
            {v.label}
          </button>
        ))}
      </nav>

      <main className="layout">
        <aside className="col-side">
          <MoodCard watchlist={watchlist} changed={changed} mood={mood} actions={chatActions} />
          {watchlist.length > 0 ? (
            <AtAGlance watchlist={watchlist} changed={changed} />
          ) : (
            <StartHere go={goStart} learnMode={learnMode} />
          )}
        </aside>

        <div className="col-main">
        {view === 'market' && (
          <>
            <section className="pane">
              <h2 className="groovy-title"><GroovyText text={'🔍 find a stock'} /></h2>
              <SymbolSearch onPick={setOpenSymbol} placeholder="search any NSE company... 🔍" buttonLabel="open" />
            </section>
            <MarketView onOpen={setOpenSymbol} />
          </>
        )}
        {view === 'scans' && <ScansView onOpen={setOpenSymbol} />}
        {view === 'funds' && <FundsView onOpen={setOpenFund} />}
        {view === 'practice' && <ShopView onOpen={setOpenSymbol} initialPick={practicePick} initialTab={shopTab} />}
        {view === 'mine' && (
        <>
        <section className="pane watchlist-pane">
          <h2 className="groovy-title"><GroovyText text={'🐾 my watchlist'} /></h2>
          <SymbolSearch onPick={handleAdd} placeholder="add a stock by name or ticker... 🔍" />
          {watchlist.length === 0 ? (
            <StarterStocks onAdd={handleAdd} />
          ) : (
            <ul className="watch-list">
              {watchlist.map((row) => (
                <WatchlistRow key={row.symbol} row={row} onRemove={handleRemove} onOpen={setOpenSymbol} />
              ))}
            </ul>
          )}
        </section>

        {watchlist.length === 0 && (
          <>
            <TodaySnapshot onOpen={setOpenSymbol} onMore={() => setView('market')} />
          </>
        )}
        {watchlist.length > 0 && (
        <section className="pane inbox-pane">
          <div className="inbox-header">
            <h2 className="groovy-title"><GroovyText text={'💌 since you last peeked'} /></h2>
            <div className="lens-switcher">
              {INBOX_TABS.map((t) => (
                <button
                  key={t.key}
                  className={inboxTab === t.key ? 'lens-btn active' : 'lens-btn'}
                  onClick={() => setInboxTab(t.key)}
                  {...ex(t.key === 'changed' ? 'since-last' : 'quiet-log')}
                >
                  {t.label}
                  {t.key === 'changed' && changed?.statements?.length > 0 && (
                    <span className="unread-dot" aria-label="new changes" />
                  )}
                </button>
              ))}
            </div>
          </div>

          {inboxTab === 'changed' ? (
            <>
              <p className="inbox-subtitle">what_changed(t0, now) -- not a log of everything that happened</p>
              {!changed ? null : watchlist.length === 0 ? (
                <div className="notice-card">
                  <p className="notice-headline">🎀 nothing to check yet</p>
                  <p className="notice-body">add a stock to your watchlist and i'll tell you here when something about it really changes.</p>
                </div>
              ) : changed.statements.length > 0 ? (
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
        )}
        </>
        )}
        </div>
      </main>
      {openSymbol && (
        <StockSheet
          symbol={openSymbol}
          inWatchlist={watchlist.some((r) => r.symbol === openSymbol)}
          onAdd={handleAdd}
          onClose={closeSheet}
          onPractice={practiceTrade}
        />
      )}
      {openFund && <FundSheet code={openFund} onClose={closeFund} />}
      <LearnBubble on={learnMode} />
      <Tour step={tour.step} setStep={tour.setStep} finish={tour.finish} />
    </div>
  )
}
