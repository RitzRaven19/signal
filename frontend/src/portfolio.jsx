// Practice portfolio (paper trading): buy and sell with pretend money at
// the latest price and watch the P&L, like a Groww holdings screen with
// nothing real at stake. No orders go anywhere. The book lives in this
// browser's localStorage, the same scope as the chat history.
import { useCallback, useEffect, useState } from 'react'
import { getQuotes } from './api'
import { GroovyText } from './groovy'
import { SymbolSearch, fmtPct, fmtPrice } from './market'
import { ex } from './explain'

const BOOK_KEY = 'signal-paper-v1'
export const START_CASH = 1000000 // ₹10 lakh of pretend money
const QUOTE_REFRESH_MS = 60000
const TRADES_SHOWN = 20

const bare = (s) => (s || '').replace(/\.NS$/, '')
const dir = (p) => (p == null ? 'flat' : p >= 0 ? 'up' : 'down')
const freshBook = () => ({ cash: START_CASH, realized: 0, holdings: {}, trades: [] })

export function loadBook() {
  try {
    const saved = JSON.parse(localStorage.getItem(BOOK_KEY))
    if (saved && typeof saved.cash === 'number' && saved.holdings) return saved
  } catch {
    // storage blocked or corrupt -- start fresh
  }
  return freshBook()
}

export function PortfolioView({ onOpen, initialPick = null }) {
  const [book, setBook] = useState(loadBook)
  const [quotes, setQuotes] = useState({})
  const [picked, setPicked] = useState(initialPick)

  // "practice trade" on a stock page lands here with that stock picked
  useEffect(() => {
    if (initialPick) setPicked(initialPick)
  }, [initialPick])
  const [qty, setQty] = useState('1')
  const [note, setNote] = useState(null)

  useEffect(() => {
    try {
      localStorage.setItem(BOOK_KEY, JSON.stringify(book))
    } catch {
      // storage full or blocked -- it still works, it just won't persist
    }
  }, [book])

  const held = Object.keys(book.holdings)
  const wanted = [...new Set([...held, ...(picked ? [picked] : [])])].sort()
  const wantedKey = wanted.join(',')

  const refresh = useCallback(async () => {
    if (!wantedKey) return
    try {
      const { quotes: q } = await getQuotes(wantedKey.split(','))
      setQuotes((old) => ({ ...old, ...q }))
    } catch {
      // keep the last prices; the next refresh will try again
    }
  }, [wantedKey])

  useEffect(() => {
    refresh()
    const id = setInterval(refresh, QUOTE_REFRESH_MS)
    return () => clearInterval(id)
  }, [refresh])

  const price = (s) => quotes[s]?.price ?? null

  // ── trading ──
  const pickedPrice = picked ? price(picked) : null
  const n = Math.floor(Number(qty))
  const validQty = Number.isFinite(n) && n > 0
  const cost = validQty && pickedPrice ? n * pickedPrice : null
  const own = picked ? book.holdings[picked]?.qty ?? 0 : 0

  const trade = (side) => {
    if (!picked || !pickedPrice || !validQty) return
    if (side === 'buy' && cost > book.cash) {
      setNote(`not enough pretend cash: that costs ${fmtPrice(cost)} and you have ${fmtPrice(book.cash)}.`)
      return
    }
    if (side === 'sell' && n > own) {
      setNote(`you only hold ${own} ${bare(picked)}.`)
      return
    }
    setBook((b) => {
      const h = b.holdings[picked] || { qty: 0, cost: 0 }
      const holdings = { ...b.holdings }
      let { cash, realized } = b
      if (side === 'buy') {
        const newQty = h.qty + n
        holdings[picked] = { qty: newQty, cost: (h.qty * h.cost + n * pickedPrice) / newQty }
        cash -= n * pickedPrice
      } else {
        realized += n * (pickedPrice - h.cost)
        cash += n * pickedPrice
        if (h.qty - n === 0) delete holdings[picked]
        else holdings[picked] = { ...h, qty: h.qty - n }
      }
      const t = { at: new Date().toISOString(), symbol: picked, side, qty: n, price: pickedPrice }
      return { cash, realized, holdings, trades: [t, ...b.trades].slice(0, 200) }
    })
    setNote(`${side === 'buy' ? 'bought' : 'sold'} ${n} ${bare(picked)} at ${fmtPrice(pickedPrice)} ✨`)
  }

  const reset = () => {
    if (window.confirm('start over with a fresh ₹10,00,000 of pretend money? this clears your practice holdings and trades.')) {
      setBook(freshBook())
      setNote('fresh start! ₹10,00,000 of pretend money to play with.')
    }
  }

  // ── totals ──
  // Today's P&L runs from yesterday's close -- or from what you paid, if
  // you bought today (you weren't holding it at yesterday's close).
  const today = new Date().toDateString()
  const boughtToday = new Set(book.trades.filter((t) => t.side === 'buy' && new Date(t.at).toDateString() === today).map((t) => t.symbol))
  const rows = held.map((s) => {
    const h = book.holdings[s]
    const p = price(s)
    const value = p != null ? p * h.qty : null
    const pnl = value != null ? value - h.cost * h.qty : null
    const base = boughtToday.has(s) ? h.cost : quotes[s]?.prev_close
    const day = base && p != null ? (p - base) * h.qty : null
    return { s, h, p, value, pnl, pnlPct: pnl != null ? pnl / (h.cost * h.qty) : null, day, dayPct: quotes[s]?.pct_change }
  })
  const pricedAll = rows.every((r) => r.value != null)
  const invested = rows.reduce((a, r) => a + r.h.cost * r.h.qty, 0)
  const holdingsValue = rows.reduce((a, r) => a + (r.value ?? r.h.cost * r.h.qty), 0)
  const total = book.cash + holdingsValue
  const totalPnl = total - START_CASH
  const dayPnl = rows.reduce((a, r) => a + (r.day ?? 0), 0)

  return (
    <>
      <section className="pane">
        <h2 className="groovy-title">
          <GroovyText text="🎀 practice portfolio" />
        </h2>
        <p className="inbox-subtitle">trade with pretend money at the latest price. nothing real is bought or sold.</p>
        <div className="paper-summary">
          <div {...ex('portfolio-value')}>
            <span>portfolio value</span>
            <strong>{fmtPrice(total)}</strong>
            <em className={`change ${dir(totalPnl)}`}>{fmtPct(totalPnl / START_CASH)} overall</em>
          </div>
          <div {...ex('pnl')}>
            <span>total P&L</span>
            <strong className={totalPnl >= 0 ? 'pnl-up' : 'pnl-down'}>{(totalPnl >= 0 ? '+' : '−') + fmtPrice(Math.abs(totalPnl))}</strong>
            <em className="paper-sub">booked {(book.realized >= 0 ? '+' : '−') + fmtPrice(Math.abs(book.realized))}</em>
          </div>
          <div {...ex('today-pnl')}>
            <span>today</span>
            <strong className={dayPnl >= 0 ? 'pnl-up' : 'pnl-down'}>{(dayPnl >= 0 ? '+' : '−') + fmtPrice(Math.abs(dayPnl))}</strong>
            <em className="paper-sub">on your holdings</em>
          </div>
          <div {...ex('cash')}>
            <span>cash left</span>
            <strong>{fmtPrice(book.cash)}</strong>
            <em className="paper-sub">invested {fmtPrice(invested)}</em>
          </div>
        </div>
        {!pricedAll && <p className="notice-asof">some prices are still loading, so those holdings are counted at what you paid.</p>}
      </section>

      <section className="pane">
        <h2 className="groovy-title">
          <GroovyText text="🛍️ place a practice trade" />
        </h2>
        <SymbolSearch
          onPick={(s) => {
            setPicked(s.includes('.') ? s : `${s}.NS`)
            setNote(null)
          }}
          placeholder="pick a stock by name or ticker... 🔍"
          buttonLabel="pick"
        />
        {picked && (
          <div className="paper-ticket">
            <div className="paper-ticket-id">
              <button className="row-open" onClick={() => onOpen(picked)} title={`open ${bare(picked)}`}>
                <span className="symbol">{bare(picked)}</span>
              </button>
              <span className="price">{pickedPrice != null ? fmtPrice(pickedPrice) : quotes[picked]?.error ? 'no price' : 'loading…'}</span>
              {own > 0 && <span className="glance-pill muted">you hold {own}</span>}
            </div>
            <label className="paper-qty">
              qty
              <input type="number" min="1" step="1" value={qty} onChange={(e) => setQty(e.target.value)} />
            </label>
            <span className="paper-cost">{cost != null ? `≈ ${fmtPrice(cost)}` : ''}</span>
            <button className="ack-btn paper-buy" onClick={() => trade('buy')} disabled={!pickedPrice || !validQty}>
              buy
            </button>
            <button className="ack-btn paper-sell" onClick={() => trade('sell')} disabled={!pickedPrice || !validQty || own === 0}>
              sell
            </button>
          </div>
        )}
        {note && <p className="paper-note">{note}</p>}
      </section>

      <section className="pane">
        <h2 className="groovy-title">
          <GroovyText text="💼 holdings" />
        </h2>
        {rows.length === 0 ? (
          <p className="empty">no practice holdings yet. pick a stock above and buy a few! 🎀</p>
        ) : (
          <ul className="mkt-list">
            {rows.map((r) => (
              <li key={r.s} className="mkt-row" tabIndex={0} onClick={() => onOpen(r.s)} onKeyDown={(e) => e.key === 'Enter' && onOpen(r.s)}>
                <div className="mkt-id">
                  <span className="symbol">{bare(r.s)}</span>
                  <span className="mkt-name" {...ex('avg-cost')}>
                    {r.h.qty} @ {fmtPrice(r.h.cost)} · now {fmtPrice(r.p)}
                  </span>
                </div>
                <span className="mkt-extra">{r.dayPct != null ? `${fmtPct(r.dayPct)} today` : '—'}</span>
                <div className="mkt-quote">
                  <span className="price">{fmtPrice(r.value)}</span>
                  <span className={`change ${dir(r.pnl)}`}>{fmtPct(r.pnlPct)}</span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="pane">
        <div className="inbox-header">
          <h2 className="groovy-title">
            <GroovyText text="🧾 trade history" />
          </h2>
          <button className="lens-btn" onClick={reset}>
            start over
          </button>
        </div>
        {book.trades.length === 0 ? (
          <p className="empty">your practice trades will show up here.</p>
        ) : (
          <ul className="mkt-list">
            {book.trades.slice(0, TRADES_SHOWN).map((t, i) => (
              <li key={i} className="event-line">
                <span className={`event-type-chip paper-${t.side}-chip`}>{t.side}</span>
                <span className="event-text">
                  {t.qty} {bare(t.symbol)} at {fmtPrice(t.price)} = {fmtPrice(t.qty * t.price)}
                </span>
                <span className="event-time">
                  {new Date(t.at).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}
                </span>
              </li>
            ))}
          </ul>
        )}
        <p className="notice-asof">practice only. prices can be up to a few minutes old, or the last close when the market is shut. your book is saved in this browser.</p>
      </section>
    </>
  )
}

export function saveBook(book) {
  try {
    localStorage.setItem(BOOK_KEY, JSON.stringify(book))
  } catch {
    // storage blocked -- nothing to do
  }
}

// Apply a buy to a book (used by the shop's checkout). Returns the new book.
export function buyInto(book, symbol, qty, price) {
  const h = book.holdings[symbol] || { qty: 0, cost: 0 }
  const newQty = h.qty + qty
  return {
    ...book,
    cash: book.cash - qty * price,
    holdings: { ...book.holdings, [symbol]: { qty: newQty, cost: (h.qty * h.cost + qty * price) / newQty } },
    trades: [{ at: new Date().toISOString(), symbol, side: 'buy', qty, price }, ...book.trades].slice(0, 200),
  }
}
