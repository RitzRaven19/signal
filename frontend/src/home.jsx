// The home page for someone who hasn't added stocks yet: instead of empty
// boxes, a live snapshot of today's market, one-tap starter stocks and a
// "start here" card. Once the watchlist has stocks, the normal view takes over.
import { useEffect, useState } from 'react'
import { getMarket, getUnusual } from './api'
import { ex } from './explain'
import { GroovyText } from './groovy'
import { BRAND_OF, BrandLogo } from './shop'

const STARTERS = ['NYKAA.NS', 'ETERNAL.NS', 'TITAN.NS', 'TCS.NS', 'HDFCBANK.NS', 'JUBLFOOD.NS']
const bare = (s) => (s || '').replace(/\.NS$/, '')
const pct = (p) => (p == null ? '—' : `${p >= 0 ? '+' : ''}${(p * 100).toFixed(2)}%`)
const dir = (p) => (p == null ? 'flat' : p >= 0 ? 'up' : 'down')

// Inside the empty watchlist: popular brands, one tap to add.
export function StarterStocks({ onAdd }) {
  return (
    <div className="starters">
      <p className="starters-label">not sure where to start? tap a brand you know to watch it 💗</p>
      <div className="starter-chips">
        {STARTERS.map((s) => (
          <button key={s} className="starter-chip" onClick={() => onAdd(s)}>
            <BrandLogo symbol={s} small />
            <span>{BRAND_OF[s] || bare(s)}</span>
            <em>+</em>
          </button>
        ))}
      </div>
    </div>
  )
}

export function StartHere({ go, learnMode }) {
  const items = [
    ['📚', 'what is a share?', 'a 1-minute lesson to start', () => go('learn')],
    ['🛍️', 'shop with pretend money', '₹10,00,000 to practise with', () => go('shop')],
    ['🔍', learnMode ? 'point & learn is on' : 'try point & learn', 'tap any word to get it explained', () => go('point')],
  ]
  return (
    <section className="pane">
      <h2 className="groovy-title">
        <GroovyText text="🌸 start here" />
      </h2>
      <div className="start-grid">
        {items.map(([emoji, title, sub, onClick]) => (
          <button key={title} className="start-card" onClick={onClick}>
            <span className="start-emoji" aria-hidden="true">
              {emoji}
            </span>
            <strong>{title}</strong>
            <span>{sub}</span>
          </button>
        ))}
      </div>
    </section>
  )
}

// A live look at today: the indices, the market's mood and what stood out.
export function TodaySnapshot({ onOpen, onMore }) {
  const [m, setM] = useState(null)
  const [u, setU] = useState(null)
  useEffect(() => {
    getMarket().then(setM).catch(() => setM(false))
    getUnusual().then(setU).catch(() => setU(false))
  }, [])

  const idx = (name) => m?.indices?.find((i) => i.name === name)
  const vix = m?.indices?.find((i) => i.symbol === '^INDIAVIX')
  const b = m?.breadth
  const total = b ? b.advances + b.declines + b.unchanged || 1 : 1
  const share = b ? b.advances / total : null
  const mood = share == null ? null : share >= 0.6 ? 'most stocks rose 🌷' : share <= 0.4 ? 'most stocks fell 🥀' : 'a mixed day 🌗'
  const sectors = (m?.sectors || []).filter((s) => s.pct_change != null).sort((a, z) => z.pct_change - a.pct_change)
  const closed = m?.indices?.some((i) => i.staleness === 'closed')

  return (
    <section className="pane">
      <div className="inbox-header">
        <h2 className="groovy-title">
          <GroovyText text="☀️ today in the market" />
        </h2>
        <button className="lens-btn" onClick={onMore}>
          see everything ›
        </button>
      </div>
      {m === null ? (
        <p className="empty">peeking at the market…</p>
      ) : m === false ? (
        <p className="empty">i couldn&apos;t reach the market data just now. try the 📈 market tab in a bit.</p>
      ) : (
        <>
          <p className="inbox-subtitle">{closed ? `market's closed · last close ${m.as_of_date}` : 'live today'}</p>
          <div className="snap-row">
            {['NIFTY 50', 'SENSEX'].map((n) => {
              const i = idx(n)
              return (
                <div key={n} className="snap-tile" {...ex('index')}>
                  <span className="index-name">{n}</span>
                  <strong>{i?.price != null ? i.price.toLocaleString('en-IN', { maximumFractionDigits: 2 }) : '—'}</strong>
                  <span className={`change ${dir(i?.pct_change)}`}>{pct(i?.pct_change)}</span>
                </div>
              )
            })}
            {b && (
              <div className="snap-tile" {...ex('breadth')}>
                <span className="index-name">market mood</span>
                <strong className="snap-mood">{mood}</strong>
                <span className="snap-sub">
                  ▲ {b.advances.toLocaleString('en-IN')} · ▼ {b.declines.toLocaleString('en-IN')}
                </span>
              </div>
            )}
            {vix?.price != null && (
              <div className="snap-tile" {...ex('vix')}>
                <span className="index-name">fear gauge</span>
                <strong>{vix.price.toFixed(2)}</strong>
                <span className="snap-sub">{vix.price < 13 ? 'calm' : vix.price < 18 ? 'a little jittery' : vix.price < 25 ? 'nervous' : 'scared'}</span>
              </div>
            )}
          </div>
          {sectors.length > 1 && (
            <p className="snap-sectors" {...ex('sector')}>
              best sector <b>{sectors[0].name}</b> <span className={`change ${dir(sectors[0].pct_change)}`}>{pct(sectors[0].pct_change)}</span> · worst <b>{sectors.at(-1).name}</b>{' '}
              <span className={`change ${dir(sectors.at(-1).pct_change)}`}>{pct(sectors.at(-1).pct_change)}</span>
            </p>
          )}
        </>
      )}
      {u && u.moves?.length > 0 && (
        <>
          <h3 className="sheet-sub" {...ex('unusual')}>
            🚨 stood out today
          </h3>
          <ul className="mkt-list">
            {u.moves.slice(0, 3).map((mv) => (
              <li key={mv.symbol} className="mkt-row" tabIndex={0} onClick={() => onOpen(mv.symbol)} onKeyDown={(e) => e.key === 'Enter' && onOpen(mv.symbol)}>
                <div className="mkt-id">
                  <span className="symbol">{bare(mv.symbol)}</span>
                  <span className="mkt-name">much more than the market ({pct(mv.index_pct)}) explains · tap for the news</span>
                </div>
                <div className="mkt-quote">
                  <span className={`change ${dir(mv.pct)}`}>{pct(mv.pct)}</span>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  )
}
