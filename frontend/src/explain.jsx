// "Point & learn" mode: switch it on and anything marked with
// data-explain shows a little mascot bubble explaining it -- hover on a
// computer, tap on a phone. In this mode a tap explains instead of acting,
// so learning never accidentally buys, removes or opens something.
import { useEffect, useRef, useState } from 'react'
import { askAI } from './api'

const MODE_KEY = 'signal-learn-mode'
export const EXPLORED_KEY = 'signal-explored-v1'

// Spread onto an element: <span {...ex('rsi')}>
export const ex = (key) => ({ 'data-explain': key })

// Plain-words explainers. Facts about what a thing is, never advice.
export const EXPLAIN = {
  // freshness badges
  'badge-live': ['live ✅', 'this price is under 2 minutes old.'],
  'badge-delayed': ['delayed ⏳', 'this price is 2 to 15 minutes old: fine for a glance.'],
  'badge-stale': ['stale 😴', "over 15 minutes old while the market's open. i'd double-check it."],
  'badge-closed': ['market closed 🌙', "NSE is shut (it trades 9:15–3:30 on weekdays), so this is the last closing price. that's the right price, not a lagging one."],
  'badge-unknown': ['unknown ❓', "i couldn't get a fresh price, so i won't pretend i have one."],

  // watchlist & inbox
  'watch-price': ['price', 'what one share costs right now (or at the last close).'],
  'pct-day': ['change today', 'how much the price moved since yesterday’s close. pink is up, mauve is down.'],
  'since-last': ['since you last peeked', 'only what really changed about your stocks since you last said "seen it". not every little wiggle.'],
  'quiet-log': ['quiet log', "alerts that fired and then went back to normal. kept here so nothing's hidden, but they don't clutter your main view."],
  'seen-it': ['seen it', 'tells me you’re caught up on that stock, so next time i only show what changed after now.'],
  'mascot': ['that’s me!', 'my face shows the mood of your watchlist: happy when most are up, confused when a price is lagging.'],
  'glance': ['at a glance', 'a quick count of your watchlist: how many you track, how many are up, and anything to read.'],

  // market
  index: ['an index', 'one number that tracks a group of big companies. NIFTY 50 follows 50 of India’s biggest; SENSEX follows 30 on BSE.'],
  breadth: ['market breadth', 'how many stocks rose vs fell today. an index can rise on a few giants while most stocks fall, and this shows that.'],
  vix: ['fear gauge (india vix)', 'how much movement traders expect over the next month. higher means more nervous; under ~13 is calm.'],
  sector: ['a sector', 'a group of companies in the same business, like IT or banks. deeper pink rose more, deeper mauve fell more.'],
  gainers: ['top gainers', 'today’s biggest rises among companies with real trading (₹1 crore+ traded, price ₹20+).'],
  losers: ['top losers', 'today’s biggest falls among companies with real trading.'],
  'most-active': ['most active', 'the companies with the most money traded today.'],
  'traded-value': ['value traded', 'the total money that changed hands in this stock today, in crores (1 crore = ₹1,00,00,000).'],
  scans: ['readymade scans', 'filters that pick out stocks doing something unusual today, like trading 3x their normal amount.'],

  // stock page
  'big-price': ['share price', 'what one share costs. it moves every second the market is open.'],
  chart: ['price chart', 'the closing price each day. hover the line to see any day; switch the range with the buttons.'],
  averages: ['moving averages', 'the average price over the last 50 or 200 days. it smooths out daily noise to show the trend.'],
  returns: ['returns', 'how much the price changed over each period. past returns don’t promise future ones.'],
  'day-range': ['today’s range', 'the lowest and highest price today. the dot is where it is now.'],
  '52w-range': ['52-week range', 'the lowest and highest price over the past year. the dot shows where today sits in that range.'],
  'prev-close': ['previous close', 'the last price yesterday when the market closed. today’s change is measured from here.'],
  volume: ['volume', 'how many shares changed hands today.'],
  'avg-volume': ['average volume', 'the usual number of shares traded per day over the last 20 days. compare today with it.'],
  delivery: ['delivery %', 'the share of today’s traded shares that buyers kept, not sold the same day. high means people are holding.'],
  trades: ['number of trades', 'how many separate buy-sell deals happened today.'],
  '52w-high': ['52-week high', 'the highest price in the past year.'],
  rsi: ['RSI', 'scores how hard a price moved lately, 0–100. above 70 is called overbought (rose fast), below 30 oversold (fell fast). it describes, it doesn’t predict.'],
  'vs-avg': ['price vs its average', 'above the average often means the trend has been up; below means down.'],
  cross: ['golden / death cross', 'golden: the 50-day average is above the 200-day. death: below. chart-watchers follow it, but it’s no guarantee.'],
  alerts: ['recent alerts', 'unusual things i spotted in this stock lately, like big block trades or heavy delivery buying.'],
  'trade-real': ['trade for real', 'opens this stock in your broker’s app, where you place real orders yourself. Signal never places real orders.'],
  practice: ['practice trade', 'try buying it with pretend money in the shop. nothing real happens.'],

  // funds
  nav: ['NAV', 'a mutual fund’s price per unit: everything it owns divided by its units. set once a day after the market closes.'],
  cagr: ['per year (CAGR)', 'the average yearly growth. 12% CAGR over 3 years means it grew as if it gained 12% every year.'],
  'fund-plan': ['direct vs regular', 'direct plans skip the distributor’s commission, so the same fund usually returns a bit more in direct.'],

  // shop & portfolio
  vibe: ['vibe tag', 'how much the price has swung day to day lately. steady 🧸 is calm, bouncy 🎈 moves a fair bit, spicy 🌶️ swings a lot.'],
  'per-share': ['price per share', 'what ONE share costs. you can buy just one to start.'],
  'pct-1m': ['1-month change', 'how much the price moved over the last month.'],
  sparkles: ['sparkles ✨', 'earned by finishing lessons and pointing at things to learn. never by trading.'],
  streak: ['learning streak 🔥', 'days in a row you learned something.'],
  diversity: ['diversity score', 'how many different aisles your closet covers. spread out = less fragile.'],
  'portfolio-value': ['portfolio value', 'your pretend cash plus what all your holdings are worth right now.'],
  pnl: ['P&L', 'profit and loss: how much you’re up or down overall versus the ₹10,00,000 you started with.'],
  'today-pnl': ['today’s P&L', 'how much your holdings moved today.'],
  cash: ['cash left', 'pretend money you haven’t spent yet.'],
  'avg-cost': ['average buy price', 'what you paid per share on average. if you buy more at a different price, it blends.'],
}

const readExplored = () => {
  try {
    return new Set(JSON.parse(localStorage.getItem(EXPLORED_KEY)) || [])
  } catch {
    return new Set()
  }
}

export function useLearnMode() {
  const [on, setOn] = useState(() => {
    try {
      return localStorage.getItem(MODE_KEY) === '1'
    } catch {
      return false
    }
  })
  useEffect(() => {
    try {
      localStorage.setItem(MODE_KEY, on ? '1' : '0')
    } catch {
      // storage blocked
    }
    document.body.classList.toggle('learn-mode', on)
  }, [on])
  return [on, setOn]
}

export function LearnToggle({ on, setOn }) {
  return (
    <button className={on ? 'learn-toggle on' : 'learn-toggle'} onClick={() => setOn((v) => !v)} aria-pressed={on}>
      {on ? '🔍 point & learn: on' : '🔍 point & learn'}
    </button>
  )
}


// What's on screen around the thing being pointed at -- the numbers the AI
// should use. Only page text; nothing about who the user is.
function contextFor(el) {
  const clean = (t) => (t || '').replace(/\s+/g, ' ').trim()
  const own = clean(el.closest('.product-card, .mkt-row, .tech-row, .stat-list > div, .index-card, .sector-tile, .watch-row')?.innerText || el.innerText)
  const area = clean(el.closest('.sheet, .pane')?.innerText)
  return `pointed at: ${own.slice(0, 400)}\nsection: ${area.slice(0, 1400)}`
}

// The floating bubble. Hover shows it; a click pins it so its "ask AI"
// button can be reached. Listens on the whole page while learn mode is on.
export function LearnBubble({ on }) {
  const [tip, setTip] = useState(null)
  const [explored, setExplored] = useState(readExplored)
  const [chat, setChat] = useState(null) // { title, about, context, messages, loading }
  const pinned = useRef(false)

  useEffect(() => {
    if (!on) {
      setTip(null)
      setChat(null)
      pinned.current = false
      return
    }
    const find = (el) => el?.closest?.('[data-explain]')
    const ours = (el) => el?.closest?.('.learn-bubble, .ai-panel, .learn-toggle')
    const show = (target, x, y, pin) => {
      const key = target.getAttribute('data-explain')
      if (!EXPLAIN[key]) return
      pinned.current = pin
      setTip({ key, x, y, pin, context: contextFor(target) })
      setExplored((prev) => {
        if (prev.has(key)) return prev
        const next = new Set(prev).add(key)
        try {
          localStorage.setItem(EXPLORED_KEY, JSON.stringify([...next]))
        } catch {
          // storage blocked
        }
        return next
      })
    }
    const over = (e) => {
      if (e.pointerType === 'touch' || pinned.current || ours(e.target)) return
      const t = find(e.target)
      if (t) show(t, e.clientX, e.clientY, false)
      else setTip(null)
    }
    // In learn mode a click/tap explains (and pins) instead of acting.
    const click = (e) => {
      if (ours(e.target)) return
      const t = find(e.target)
      if (!t) {
        pinned.current = false
        return setTip(null)
      }
      e.preventDefault()
      e.stopPropagation()
      const r = t.getBoundingClientRect()
      show(t, r.left + r.width / 2, r.bottom, true)
    }
    const esc = (e) => {
      if (e.key !== 'Escape') return
      pinned.current = false
      setTip(null)
    }
    document.addEventListener('pointerover', over)
    document.addEventListener('click', click, true)
    document.addEventListener('keydown', esc)
    return () => {
      document.removeEventListener('pointerover', over)
      document.removeEventListener('click', click, true)
      document.removeEventListener('keydown', esc)
    }
  }, [on])

  const send = async (state, question) => {
    const history = state.messages.map((m) => ({ role: m.role, text: m.text }))
    const next = { ...state, loading: true, messages: question ? [...state.messages, { role: 'user', text: question }] : state.messages }
    setChat(next)
    let reply
    try {
      reply = await askAI({ title: state.title, about: state.about, context: state.context, history, question })
    } catch {
      reply = { ok: false, text: "i couldn't reach the AI just now. try again in a moment?" }
    }
    setChat((c) => c && { ...c, loading: false, messages: [...c.messages, { role: 'model', text: reply.text, fallback: !reply.ok }] })
  }

  const openChat = () => {
    const [title, about] = EXPLAIN[tip.key]
    const state = { title, about, context: tip.context, messages: [], loading: false }
    pinned.current = false
    setTip(null)
    send(state, '')
  }

  if (!on) return null
  return (
    <>
      {tip && <Bubble tip={tip} explored={explored} onAsk={openChat} />}
      {chat && <AiPanel chat={chat} onSend={(q) => send(chat, q)} onClose={() => setChat(null)} />}
    </>
  )
}

function Bubble({ tip, explored, onAsk }) {
  const [title, text] = EXPLAIN[tip.key]
  const W = 280
  const left = Math.max(12, Math.min(tip.x - W / 2, window.innerWidth - W - 12))
  const below = tip.y < window.innerHeight - 220
  const style = below ? { left, top: tip.y + 16 } : { left, bottom: window.innerHeight - tip.y + 16 }
  const total = Object.keys(EXPLAIN).length
  return (
    <div className={tip.pin ? 'learn-bubble pinned' : 'learn-bubble'} style={{ ...style, width: W }} role="tooltip">
      <span className="learn-avatar" aria-hidden="true" />
      <div>
        <strong className="learn-title">{title}</strong>
        <p className="learn-text">{text}</p>
        {tip.pin ? (
          <button className="ask-ai-btn" onClick={onAsk}>
            ask AI more ✨
          </button>
        ) : (
          <span className="learn-count">click to ask the AI about it · explored {explored.size}/{total} ✨</span>
        )}
      </div>
    </div>
  )
}

function AiPanel({ chat, onSend, onClose }) {
  const [draft, setDraft] = useState('')
  const logRef = useRef(null)
  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: 'smooth' })
  }, [chat.messages, chat.loading])
  const submit = (e) => {
    e.preventDefault()
    if (!draft.trim() || chat.loading) return
    onSend(draft.trim())
    setDraft('')
  }
  return (
    <aside className="ai-panel" aria-label="AI explainer">
      <div className="ai-head">
        <span className="learn-avatar" aria-hidden="true" />
        <div>
          <strong className="learn-title">{chat.title}</strong>
          <span className="learn-count">explained by AI · may make mistakes</span>
        </div>
        <button className="chat-close" onClick={onClose} aria-label="close AI explainer">
          ×
        </button>
      </div>
      <ul className="ai-log" ref={logRef} aria-live="polite">
        {chat.messages.map((m, i) => (
          <li key={i} className={`chat-msg from-${m.role === 'user' ? 'you' : 'her'}${m.fallback ? ' ai-fallback' : ''}`}>
            {m.text}
            {m.fallback && <span className="ai-builtin">{chat.about}</span>}
          </li>
        ))}
        {chat.loading && (
          <li className="chat-msg from-her chat-typing" aria-label="thinking">
            <span />
            <span />
            <span />
          </li>
        )}
      </ul>
      <form className="chat-form" onSubmit={submit}>
        <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="ask a follow-up…" aria-label="follow-up question" />
        <button type="submit" disabled={chat.loading}>
          ask
        </button>
      </form>
      <p className="ai-note">sent to Google’s free Gemini AI along with the text on screen; Google may use it to improve its products. don’t type personal info. explanations only, never advice.</p>
    </aside>
  )
}
