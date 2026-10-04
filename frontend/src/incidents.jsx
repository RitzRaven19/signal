// Incidents: the day's moves the market doesn't explain, and for any stock,
// its recent headlines, NSE announcements and an AI "why did it move?"
// summary. Explains what happened; never predicts what happens next.
import { useEffect, useState } from 'react'
import { getStockNews, getUnusual, whyMoved } from './api'
import { ex } from './explain'
import { GroovyText } from './groovy'

const bare = (s) => (s || '').replace(/\.NS$/, '')
const pct = (p) => (p == null ? '—' : `${p >= 0 ? '+' : ''}${(p * 100).toFixed(2)}%`)
const ago = (iso) => {
  if (!iso) return ''
  const h = (Date.now() - new Date(iso).getTime()) / 3600000
  if (h < 1) return 'just now'
  if (h < 24) return `${Math.round(h)}h ago`
  return `${Math.round(h / 24)}d ago`
}

export function UnusualMoves({ onOpen }) {
  const [data, setData] = useState(null)
  useEffect(() => {
    getUnusual()
      .then(setData)
      .catch(() => setData({ moves: [], checked: 0, unavailable: true }))
  }, [])
  if (!data) return null
  return (
    <section className="pane">
      <h2 className="groovy-title" {...ex('unusual')}>
        <GroovyText text="🚨 unusual moves" />
      </h2>
      <p className="inbox-subtitle">
        moves the market doesn&apos;t explain, among the {data.checked || 150} most-traded stocks{data.as_of_date ? ` · ${data.as_of_date}` : ''}. tap one to see the news behind it.
      </p>
      {data.unavailable ? (
        <p className="empty">i couldn&apos;t get the market data to check this right now. try again in a bit.</p>
      ) : data.moves.length === 0 ? (
        <p className="empty">nothing unusual stood out in the last session. 🌸</p>
      ) : (
        <ul className="mkt-list">
          {data.moves.map((m) => (
            <li key={m.symbol} className="mkt-row" tabIndex={0} onClick={() => onOpen(m.symbol)} onKeyDown={(e) => e.key === 'Enter' && onOpen(m.symbol)}>
              <div className="mkt-id">
                <span className="symbol">{bare(m.symbol)}</span>
                <span className="mkt-name">
                  NIFTY {pct(m.index_pct)} · the market explains about {pct(m.explained_pct)}
                </span>
              </div>
              <span className="mkt-extra" title="how many times bigger than its usual unexplained move">
                {Math.abs(m.z).toFixed(1)}× usual
              </span>
              <div className="mkt-quote">
                <span className={`change ${m.pct >= 0 ? 'up' : 'down'}`}>{pct(m.pct)}</span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

export function StockNews({ symbol }) {
  const [data, setData] = useState(null)
  const [why, setWhy] = useState(null) // { loading } | { ok, text }

  useEffect(() => {
    let live = true
    setData(null)
    setWhy(null)
    getStockNews(symbol)
      .then((d) => live && setData(d))
      .catch(() => live && setData({ news: [], announcements: [] }))
    return () => {
      live = false
    }
  }, [symbol])

  const ask = async () => {
    setWhy({ loading: true })
    try {
      setWhy(await whyMoved(symbol))
    } catch {
      setWhy({ ok: false, text: "i couldn't reach the AI just now. try again in a moment?" })
    }
  }

  return (
    <>
      <h3 className="sheet-sub" {...ex('news')}>
        📰 news &amp; announcements
      </h3>
      <button className="ask-ai-btn why-btn" onClick={ask} disabled={why?.loading} {...ex('why')}>
        {why?.loading ? 'reading the news…' : '✨ why did it move?'}
      </button>
      {why && !why.loading && (
        <div className={why.ok ? 'why-answer' : 'why-answer muted'}>
          <span className="learn-avatar small" aria-hidden="true" />
          <p>
            {why.text}
            {why.ok && <span className="why-note">AI summary of the headlines below · may make mistakes · not advice</span>}
          </p>
        </div>
      )}
      {!data ? (
        <p className="empty">looking for news…</p>
      ) : (
        <>
          {data.announcements.length > 0 && (
            <ul className="news-list">
              {data.announcements.map((a, i) => (
                <li key={`a${i}`} className="news-item">
                  <span className="event-type-chip">NSE · {a.subject}</span>
                  <a href={a.pdf} target="_blank" rel="noopener noreferrer">
                    {a.text || a.subject}
                  </a>
                  <span className="event-time">{a.at?.slice(0, 10)}</span>
                </li>
              ))}
            </ul>
          )}
          {data.news.length > 0 ? (
            <ul className="news-list">
              {data.news.map((n, i) => (
                <li key={`n${i}`} className="news-item">
                  <a href={n.link} target="_blank" rel="noopener noreferrer">
                    {n.title}
                  </a>
                  <span className="event-time">
                    {n.source} · {ago(n.published)}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="empty">no headlines about this company in the last week.</p>
          )}
          <p className="notice-asof">headlines via Google News, announcements from NSE. links open the original source.</p>
        </>
      )}
    </>
  )
}
