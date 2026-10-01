// The mascot's chat brain. Free, no model: keyword intents answered in
// her voice from the app's live data. Watchlist questions are answered
// offline by `reply`; market and any-stock questions by `replyAsync`,
// which reads our own API. Every number she says is one the page shows,
// so she can't contradict the screen.

import { getMarket, getStock, searchSymbols } from './api'
import { periodReturn, rsi, rsiReading } from './market'

const pct = (p) => (p == null ? null : `${p >= 0 ? '+' : ''}${(p * 100).toFixed(1)}%`)
const bare = (s) => s.replace(/\.NS$/, '')

const STALENESS_EXPLAIN = {
  live: 'live means the price is under 2 minutes old.',
  delayed: 'delayed means 2 to 15 minutes old, still fine for a glance.',
  stale: "stale means over 15 minutes old during market hours. i'd double-check before acting.",
  closed: "market closed means NSE is shut, so you're seeing the last close. that's the right price, not a lagging one.",
  unknown: "unknown means i couldn't get a fresh price at all, so i won't pretend i have one.",
}

export const QUICK_REPLIES = ["how's the market?", 'best sector today?', 'what changed?', 'how are my stocks?', 'tell me about TCS', 'what do the badges mean?']

function findSymbol(text, watchlist) {
  const t = text.toUpperCase()
  return watchlist.find((r) => new RegExp(`\\b${bare(r.symbol).replace(/[&]/g, '\\&')}\\b`).test(t))
}

function stockLine(row, statements) {
  const name = bare(row.symbol)
  const mine = statements.filter((s) => s.symbol === row.symbol)
  let line =
    row.price == null
      ? `i couldn't get a price for ${name}, so i'm not guessing one.`
      : `${name} is at ₹${row.price.toLocaleString('en-IN', { maximumFractionDigits: 2 })}` +
        (row.pct_change != null ? ` (${pct(row.pct_change)} on the day)` : '') +
        (row.staleness === 'closed' ? ', as of the last close.' : '.')
  if (mine.length) line += ` since you last peeked, it ${mine.map((s) => s.reason.replace(`${row.symbol} `, '')).join(' it ')}`
  else if (row.price != null) line += " nothing's changed for it that's worth telling you."
  return line
}

export function reply(input, { watchlist, changed, mood }) {
  const text = input.trim().toLowerCase()
  const statements = changed?.statements ?? []
  const has = (...words) => words.some((w) => text.includes(w))

  if (!text) return "say something! i'm listening."

  if (has('buy', 'sell', 'invest', 'should i', 'recommend', 'tip')) {
    return "i can't tell you what to buy or sell. i'm not a financial advisor, just your watchlist bestie. i can tell you what changed and why, though!"
  }

  const row = findSymbol(input, watchlist)
  if (row) return stockLine(row, statements)

  if (/^(hi|hey|hello|yo|hii+)\b/.test(text)) {
    return `hiii! i keep an eye on your stocks and tell you only what actually changed. ${
      watchlist.length ? `you've got ${watchlist.length} on your list.` : 'add a stock and i\'ll start watching it.'
    } ask me anything below!`
  }

  if (has('what changed', 'changes', 'since', 'summary', 'today', 'news', 'update')) {
    if (!watchlist.length) return 'nothing to report yet. your watchlist is empty! add a stock up top.'
    if (statements.length) {
      return `${statements.length} thing${statements.length > 1 ? 's' : ''} changed since you last peeked: ${statements
        .map((s) => s.reason)
        .join(' ')}`
    }
    if (changed?.insufficient_history?.length) {
      return `i'm still learning ${changed.insufficient_history.map((h) => bare(h.symbol)).join(', ')}. i need more days of price history before i can say what changed.`
    }
    return "nothing changed that's worth your attention. moves that came and went don't count, and they're in the quiet log if you're curious."
  }

  if (has('my stocks', 'how are', 'portfolio', 'watchlist', 'doing')) {
    if (!watchlist.length) return 'your watchlist is empty! type a symbol like RELIANCE.NS up top and hit add.'
    const up = watchlist.filter((r) => r.pct_change > 0).length
    const down = watchlist.filter((r) => r.pct_change < 0).length
    const best = [...watchlist].filter((r) => r.pct_change != null).sort((a, b) => b.pct_change - a.pct_change)[0]
    return `${up} up, ${down} down out of ${watchlist.length}.${
      best ? ` best one: ${bare(best.symbol)} at ${pct(best.pct_change)}.` : ''
    } ask me about any of them by name!`
  }

  for (const [tier, explain] of Object.entries(STALENESS_EXPLAIN)) {
    if (text.includes(tier)) return explain
  }
  if (has('badge', 'staleness', 'lagging', 'fresh')) {
    return 'each badge says how old the price is. live is under 2 minutes, delayed under 15, stale older than that, and market closed means the last close. unknown means i got nothing, so i say so.'
  }

  if (has('quiet log', 'quiet')) {
    return 'the quiet log is alerts that fired and then went back to normal before they changed anything lasting. i keep them there so nothing gets hidden, but they don\'t clutter your main view.'
  }

  if (has('seen it', 'ack', 'mark', 'peeked', 'last checked')) {
    return '"seen it" tells me you\'ve caught up on that stock. next time, i only tell you what changed after that moment.'
  }

  if (has('add', 'remove', 'delete', 'how do i')) {
    return 'type a symbol in the box under "my watchlist" and hit add. use the NSE form with .NS, like INFY.NS. the little × on a row removes it.'
  }

  if (has('mood', 'why are you', 'feeling', 'happy', 'confused', 'sad')) {
    return {
      happy: "i'm happy because most of your stocks are up!",
      confused: "i look confused because at least one price is lagging, and i'd rather say so than guess.",
      neutral: "i'm calm. nothing big is happening, and that's good news.",
      cat: "i'm just hanging out with my cat until you add some stocks.",
    }[mood]
  }

  if (has('help', 'what can you', 'who are you')) {
    return "i'm signal's mascot! ask me how the market's doing, the best sector, top gainers or losers, the fear gauge, about any NSE stock by name, what changed, or what the badges, quiet log and \"seen it\" mean."
  }

  return "hmm, i didn't catch that. i'm a simple bot! try one of the buttons below, or ask about any stock by name, like \"tell me about infosys\"."
}

// ── Market questions ─────────────────────────────────────────────────
// These need data beyond the watchlist, so they read our own API --
// still free, and still only numbers the market tab shows.

const MARKET_WORDS = ['market', 'nifty', 'sensex', 'index', 'indices', 'sector', 'vix', 'fear', 'gainer', 'loser', 'breadth', 'movers', 'midcap', 'smallcap', 'top stocks']
const LOOKUP = /(?:tell me about|what about|how is|how's|hows|price of|look up|lookup|about|check)\s+(.+)$/
const FILLER = /\b(doing|today|now|stock|stocks|share|shares|price|please|pls|going|lately)\b/g
const NOT_A_STOCK = new Set(['it', 'my stocks', 'my watchlist', 'the badges', 'badges', 'you', 'the quiet log', 'quiet log'])

let marketCache = { at: 0, data: null }
async function market() {
  if (Date.now() - marketCache.at > 60000) marketCache = { at: Date.now(), data: await getMarket() }
  return marketCache.data
}

const num = (n) => n.toLocaleString('en-IN', { maximumFractionDigits: 2 })
const moverList = (rows) => rows.slice(0, 3).map((r) => `${bare(r.symbol)} ${pct(r.pct)}`).join(', ')

async function marketReply(text) {
  const m = await market()
  const has = (...w) => w.some((x) => text.includes(x))
  const sectors = (m.sectors || []).filter((s) => s.pct_change != null).sort((a, b) => b.pct_change - a.pct_change)
  const vix = m.indices.find((i) => i.symbol === '^INDIAVIX')
  const closed = m.indices.some((i) => i.staleness === 'closed') ? ' (as of the last close)' : ''

  if (has('sector') && sectors.length) {
    const up = sectors.filter((s) => s.pct_change > 0)
    return `best sector: ${sectors[0].name} at ${pct(sectors[0].pct_change)}. worst: ${sectors.at(-1).name} at ${pct(sectors.at(-1).pct_change)}. ${
      up.length ? `${up.length} of ${sectors.length} sectors are up` : 'every sector is down'
    }${closed}.`
  }
  if (has('vix', 'fear') && vix?.price != null) {
    const level = vix.price < 13 ? 'calm' : vix.price < 18 ? 'a little jittery' : vix.price < 25 ? 'nervous' : 'scared'
    return `india vix is ${vix.price.toFixed(2)}, so traders feel ${level}. it's how much movement they expect over the next month: higher means more nervous.`
  }
  if (has('loser')) return `today's biggest falls: ${moverList(m.movers.losers)}. tap 📈 market to see more.`
  if (has('gainer', 'movers', 'top stocks')) return `today's biggest rises: ${moverList(m.movers.gainers)}. tap 📈 market to see more.`

  const idx = (name) => m.indices.find((i) => i.name === name)
  const nifty = idx('NIFTY 50')
  const sensex = idx('SENSEX')
  const b = m.breadth
  let line = nifty?.price != null ? `NIFTY 50 is at ${num(nifty.price)} (${pct(nifty.pct_change)})` : "i couldn't get NIFTY right now"
  if (sensex?.price != null) line += ` and SENSEX at ${num(sensex.price)} (${pct(sensex.pct_change)})`
  line += `${closed}.`
  if (b) {
    const share = b.advances / (b.advances + b.declines + b.unchanged || 1)
    line += ` ${num(b.advances)} stocks rose and ${num(b.declines)} fell, so ${
      share >= 0.6 ? 'most of the market was up' : share <= 0.4 ? 'most of the market was down' : "it's a mixed day"
    }.`
  }
  if (sectors.length) line += ` best sector ${sectors[0].name} ${pct(sectors[0].pct_change)}, worst ${sectors.at(-1).name} ${pct(sectors.at(-1).pct_change)}.`
  return line
}

async function stockReply(query, watchlist) {
  const { results } = await searchSymbols(query)
  const q = query.toUpperCase()
  const hit =
    results.find((r) => bare(r.symbol) === q) ||
    results.find((r) => r.name.toUpperCase().includes(q) || bare(r.symbol).startsWith(q))
  if (!hit) return null
  const s = await getStock(hit.symbol)
  const closes = s.bars.map((x) => x.c)
  const parts = [`${s.name} (${bare(s.symbol)}) is at ₹${num(s.price)}, ${pct(s.pct_change)} ${s.staleness === 'closed' ? 'at the last close' : 'today'}.`]
  const m1 = periodReturn(closes, 21)
  const y1 = periodReturn(closes, 252)
  if (m1 != null) parts.push(`it's ${pct(m1)} over a month${y1 != null ? ` and ${pct(y1)} over a year` : ''}.`)
  if (s.week52_high) {
    const fromHigh = s.price / s.week52_high - 1
    parts.push(fromHigh > -0.02 ? 'it is right near its 52-week high.' : `it's ${Math.abs(fromHigh * 100).toFixed(0)}% below its 52-week high.`)
  }
  const r = rsi(closes)
  if (r != null) parts.push(`RSI is ${r.toFixed(0)}, ${rsiReading(r).split(':')[0]}.`)
  if (s.events?.length) parts.push(`${s.events.length} alert${s.events.length > 1 ? 's' : ''} in the last 45 days.`)
  parts.push(watchlist.some((w) => w.symbol === s.symbol) ? "it's on your watchlist." : 'search it up top to see its full page or add it.')
  return parts.join(' ')
}

// The chat's front door: market and any-stock questions are answered from
// the API, everything else by the offline `reply`.
export async function replyAsync(input, ctx) {
  const text = input.trim().toLowerCase()
  const has = (...w) => w.some((x) => text.includes(x))
  if (!text || has('buy', 'sell', 'invest', 'should i', 'recommend', 'tip') || findSymbol(input, ctx.watchlist)) {
    return reply(input, ctx)
  }
  try {
    if (has(...MARKET_WORDS)) return await marketReply(text)

    const looked = text.replace(/[?!.]+$/, '').match(LOOKUP)
    let query = looked ? looked[1].replace(FILLER, '').replace(/\s+/g, ' ').trim() : null
    const fallback = reply(input, ctx)
    // A bare word or two ("tcs", "hdfc bank") the offline brain doesn't know.
    if (!query && fallback.startsWith("hmm, i didn't catch that") && text.split(/\s+/).length <= 3) {
      query = text.replace(/[?!.]+$/, '')
    }
    if (query && query.length >= 2 && !NOT_A_STOCK.has(query)) {
      const answer = await stockReply(query, ctx.watchlist)
      if (answer) return answer
      if (looked) return `i couldn't find a stock called "${query}". try its NSE ticker, like TCS or INFY.`
    }
    return fallback
  } catch {
    return "i couldn't reach the market data just now. try again in a moment?"
  }
}
