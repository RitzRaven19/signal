// The mascot's chat brain. Free, no model: keyword intents answered in
// her voice from the app's live data. Watchlist questions are answered
// offline by `reply`; market and any-stock questions by `replyAsync`,
// which reads our own API. Every number she says is one the page shows,
// so she can't contradict the screen.

import { getFund, getMarket, getScan, getStock, searchFunds, searchSymbols } from './api'
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

export const QUICK_REPLIES = ["how's the market?", 'tell me about TCS', 'volume shockers', 'compare TCS and INFY', 'what is RSI?', 'parag parikh flexi cap fund']

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

  // whole words: as substrings, "tip" matched "multiple"
  if (/\b(buy|sell|invest|should i|recommend|tips?)\b/.test(text)) {
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
    if (!watchlist.length) return "your watchlist is empty! say \"add TCS\" and i'll add it, or search under \"my watchlist\"."
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
    return "just tell me! say \"add TCS\" or \"remove TCS\" and i'll do it. you can also use the search box under \"my watchlist\"."
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

// ── The async brain ──────────────────────────────────────────────────
// Market, any-stock, fund, scan and glossary questions, plus actions on
// the watchlist. These read our own API -- still free, and still only
// numbers the app shows. Replies are { text, links, chips, action }:
//   links  -- tickers/funds in the text that open their page when tapped
//   chips  -- follow-up questions that fit what was just asked
//   action -- something for the app to do (add/remove/open)

const MARKET_WORDS = ['market', 'nifty', 'sensex', 'index', 'indices', 'sector', 'vix', 'fear', 'gainer', 'loser', 'breadth', 'movers', 'midcap', 'smallcap', 'top stocks']
const LOOKUP = /(?:tell me about|what about|how is|how's|hows|price of|look up|lookup|about|check)\s+(.+)$/
const FILLER = /\b(doing|today|now|stock|stocks|share|shares|price|please|pls|going|lately)\b/g
const NOT_A_STOCK = new Set(['it', 'my stocks', 'my watchlist', 'the badges', 'badges', 'you', 'the quiet log', 'quiet log'])
const ADVICE = /\b(buy|sell|invest|should i|recommend|tips?|best fund|best stock)\b/

const ADD = /^(?:please\s+)?(?:add|track|watch)\s+(.+?)(?:\s+(?:to|on)\s+(?:my\s+)?(?:watchlist|list))?$/
const REMOVE = /^(?:please\s+)?(?:remove|delete|untrack|unwatch|drop)\s+(.+?)(?:\s+from\s+(?:my\s+)?(?:watchlist|list))?$/
const OPEN = /^(?:open|show(?:\s+me)?|view|chart(?:\s+of)?)\s+(.+?)(?:'s)?(?:\s+(?:chart|page|stock))?$/
const COMPARE = /^(?:compare\s+(.+?)\s+(?:and|with|to|vs\.?|versus)\s+(.+)|(.+?)\s+(?:vs\.?|versus)\s+(.+))$/
const DEFINE = /\b(what is|what's|whats|what are|meaning of|define|explain|what does)\b/

// [words that ask for it, scan, what its results did, chip label]
const SCANS = [
  [['volume shocker', 'volume spike', 'unusual volume'], 'volume_shockers', 'traded 3x+ their usual volume', 'volume shockers'],
  [['high delivery', 'delivery buying'], 'high_delivery', 'had 60%+ delivery (people holding, not day-trading)', 'high delivery stocks'],
  [['block trade', 'big trades', 'whale'], 'block_trades', 'had block trades', 'block trades'],
  [['near high', '52 week high', '52-week high', 'near their high', 'all time high'], 'near_high', 'closed near their recent high', 'stocks near their high'],
]

// Plain-words explainers. Kept factual and short; nothing here predicts.
const GLOSSARY = [
  [['a share', 'a stock'], "a share is a tiny slice of a company. own one share of Titan and you own a tiny piece of Titan: its stores, brands and profits. there's a 1-minute lesson on it in 🛍️ shop → 📚 learn."],
  [['diversification', 'diversify', 'diversified'], "diversifying means owning different kinds of companies, so one bad day for one doesn't sink everything. your closet in 🛍️ shop shows a diversity score."],
  [['spicy', 'steady', 'bouncy', 'vibe', 'vibe tag', 'volatility'], "the vibe tags in the shop describe how much a price has swung day to day lately: steady 🧸 moves calmly, bouncy 🎈 moves a fair bit, spicy 🌶️ swings a lot. they describe the past, they don't say what to buy."],
  [['sparkles', 'the shop', 'stock shop', 'streak'], "in 🛍️ shop you 'buy' real companies with ₹10,00,000 of pretend money. you earn ✨ sparkles and badges by learning, spreading out and being patient, never by trading a lot."],
  [['rsi', 'relative strength'], "RSI scores how hard a stock has moved lately, from 0 to 100. above 70 is called overbought (it rose fast), below 30 oversold (it fell fast). it describes momentum, it doesn't predict."],
  [['delivery'], "delivery % is the share of the day's traded shares that buyers actually kept instead of selling the same day. high delivery means people are holding, not just day-trading."],
  [['nav'], "NAV (net asset value) is a mutual fund's price per unit: everything the fund owns divided by its units. it's set once a day after the market closes."],
  [['cagr'], 'CAGR is the average yearly growth rate. 12% CAGR over 3 years means it grew as if it gained 12% every year, even if the real years were bumpier.'],
  [['golden cross', 'death cross'], "a golden cross is when the 50-day average climbs above the 200-day average, a death cross the opposite. chart watchers follow them, but they're not guarantees."],
  [['moving average', '50 day', '200 day', '50-day', '200-day', 'sma'], 'a moving average is the average close over the last N days, which smooths out daily noise. the 50-day shows the short-term trend, the 200-day the long-term one.'],
  [['breadth', 'advance', 'decline'], 'market breadth counts how many stocks rose vs fell. an index can rise on a few big names while most stocks fall, and breadth shows that.'],
  [['52-week high', '52 week', '52-week'],"the 52-week high and low are the highest and lowest prices over the past year. near the high means it's at the top of its yearly range."],
  [['block trade'], 'a block trade is a few very large trades, usually institutions moving big positions at once.'],
  [['volume'], 'volume is how many shares traded. a volume shocker traded 3x or more of its own usual 20-day volume, so something got people interested.'],
  [['vix'], 'india vix is how much movement traders expect over the next month. higher means more nervous; under ~13 is calm, over ~25 is scared.'],
  [['direct plan', 'regular plan', 'direct vs regular', 'direct or regular'], "direct plans skip the distributor's commission, so the same fund's direct plan costs less and usually returns a bit more than its regular plan."],
  [['elss', 'tax saver'], 'ELSS funds are equity mutual funds with a 3-year lock-in that qualify for a tax deduction under section 80C (in the old tax regime).'],
  [['sip'], 'an SIP puts a fixed amount into a mutual fund every month automatically, so you buy more units when prices are low and fewer when they are high.'],
  [['index fund'], "an index fund copies an index like NIFTY 50, so it's cheap and matches the market instead of trying to beat it."],
  [['p/e', 'pe ratio', 'price to earnings', 'fundamental', 'eps', 'market cap'], "P/E and other fundamentals need paid data, so i can't show them, sorry! i stick to free prices, NSE delivery data and fund NAVs."],
  [['bhavcopy'], "the bhavcopy is NSE's official end-of-day file with every stock's prices, volume and delivery. i read it every evening."],
  [['nifty 50', 'nifty'], "NIFTY 50 is NSE's index of 50 of India's biggest companies. when people say 'the market', they usually mean it (or SENSEX, BSE's 30-company index)."],
]

// A bare term ("rsi") gets its definition, except these, which are also
// live-data words ("block trades" means today's list, not a definition).
const LIVE_TERMS = new Set(['vix', 'nifty', 'nifty 50', 'volume', 'block trade', 'delivery', '52 week', '52-week', 'breadth', 'advance', 'decline'])
const SKIP_OPEN = /market|nifty|sensex|sector|gainer|loser|shocker|delivery|block|fund|watchlist|my stocks/

const DEFAULT_CHIPS = ["how's the market?", 'best sector today?', 'volume shockers', 'how are my stocks?', 'what is RSI?']

let marketCache = { at: 0, data: null }
async function market() {
  if (Date.now() - marketCache.at > 60000) marketCache = { at: Date.now(), data: await getMarket() }
  return marketCache.data
}

const num = (n) => n.toLocaleString('en-IN', { maximumFractionDigits: 2 })
const link = (symbol) => ({ label: bare(symbol), symbol })
const clean = (t) => t.replace(/[?!.]+$/, '').trim()
const moverList = (rows) => rows.slice(0, 3).map((r) => `${bare(r.symbol)} ${pct(r.pct)}`).join(', ')

async function findStock(query) {
  const { results } = await searchSymbols(query)
  const q = query.toUpperCase()
  return (
    results.find((r) => bare(r.symbol) === q) ||
    results.find((r) => r.name.toUpperCase().includes(q) || bare(r.symbol).startsWith(q)) ||
    null
  )
}

const escapeRe = (t) => t.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')

function glossary(text) {
  const define = DEFINE.test(text)
  for (const [terms, answer] of GLOSSARY) {
    const hit = define
      ? terms.some((t) => new RegExp(`(^|[^a-z])${escapeRe(t)}([^a-z]|$)`).test(text))
      : terms.some((t) => !LIVE_TERMS.has(t) && text.replace(/s$/, '') === t)
    if (hit) {
      const others = GLOSSARY.filter((g) => g[1] !== answer).map((g) => g[0][0])
      const pick = [0, 3, 6].map((i) => others[(answer.length + i) % others.length])
      return { text: answer, chips: pick.map((t) => `what is ${t}?`) }
    }
  }
  return null
}

async function marketReply(text) {
  const m = await market()
  const has = (...w) => w.some((x) => text.includes(x))
  const sectors = (m.sectors || []).filter((s) => s.pct_change != null).sort((a, b) => b.pct_change - a.pct_change)
  const vix = m.indices.find((i) => i.symbol === '^INDIAVIX')
  const closed = m.indices.some((i) => i.staleness === 'closed') ? ' (as of the last close)' : ''
  const chips = ["how's the market?", 'best sector today?', 'top gainers', 'top losers', 'fear gauge'].filter((c) => !text.includes(c.replace('?', '')))

  if (has('sector') && sectors.length) {
    const up = sectors.filter((s) => s.pct_change > 0)
    return {
      text: `best sector: ${sectors[0].name} at ${pct(sectors[0].pct_change)}. worst: ${sectors.at(-1).name} at ${pct(sectors.at(-1).pct_change)}. ${
        up.length ? `${up.length} of ${sectors.length} sectors are up` : 'every sector is down'
      }${closed}.`,
      chips,
    }
  }
  if (has('vix', 'fear') && vix?.price != null) {
    const level = vix.price < 13 ? 'calm' : vix.price < 18 ? 'a little jittery' : vix.price < 25 ? 'nervous' : 'scared'
    return { text: `india vix is ${vix.price.toFixed(2)}, so traders feel ${level}. higher means more nervous.`, chips }
  }
  if (has('loser') || has('gainer', 'movers', 'top stocks')) {
    const rows = (has('loser') ? m.movers.losers : m.movers.gainers).slice(0, 3)
    return {
      text: `today's biggest ${has('loser') ? 'falls' : 'rises'}: ${moverList(rows)}. tap one to see its page.`,
      links: rows.map((r) => link(r.symbol)),
      chips: [...rows.slice(0, 1).map((r) => `tell me about ${bare(r.symbol)}`), ...chips],
    }
  }

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
  return { text: line, chips }
}

async function stockSummary(symbol) {
  const s = await getStock(symbol)
  const closes = s.bars.map((x) => x.c)
  return {
    s,
    m1: periodReturn(closes, 21),
    y1: periodReturn(closes, 252),
    fromHigh: s.week52_high ? s.price / s.week52_high - 1 : null,
    rsi: rsi(closes),
  }
}

async function stockReply(hit, watchlist) {
  const { s, m1, y1, fromHigh, rsi: r } = await stockSummary(hit.symbol)
  const t = bare(s.symbol)
  const parts = [`${s.name} (${t}) is at ₹${num(s.price)}, ${pct(s.pct_change)} ${s.staleness === 'closed' ? 'at the last close' : 'today'}.`]
  if (m1 != null) parts.push(`it's ${pct(m1)} over a month${y1 != null ? ` and ${pct(y1)} over a year` : ''}.`)
  if (fromHigh != null) parts.push(fromHigh > -0.02 ? 'it is right near its 52-week high.' : `it's ${Math.abs(fromHigh * 100).toFixed(0)}% below its 52-week high.`)
  if (r != null) parts.push(`RSI is ${r.toFixed(0)}, ${rsiReading(r).split(':')[0]}.`)
  if (s.events?.length) parts.push(`${s.events.length} alert${s.events.length > 1 ? 's' : ''} in the last 45 days.`)
  const mine = watchlist.some((w) => w.symbol === s.symbol)
  parts.push(mine ? "it's on your watchlist." : `tap ${t} for its full page.`)
  return {
    text: parts.join(' '),
    links: [link(s.symbol)],
    chips: [mine ? `remove ${t}` : `add ${t}`, `open ${t}`, `compare ${t} and ${t === 'INFY' ? 'TCS' : 'INFY'}`, 'what is RSI?'],
  }
}

async function compareReply(a, b) {
  const [ha, hb] = await Promise.all([findStock(a), findStock(b)])
  if (!ha || !hb) return { text: `i couldn't find ${!ha ? `"${a}"` : `"${b}"`}. try NSE tickers, like "compare TCS and INFY".` }
  const [A, B] = await Promise.all([stockSummary(ha.symbol), stockSummary(hb.symbol)])
  const ta = bare(A.s.symbol)
  const tb = bare(B.s.symbol)
  const row = (label, x, y, fmt = pct) => (x == null || y == null ? null : `${label}: ${fmt(x)} vs ${fmt(y)}`)
  const lines = [
    row('today', A.s.pct_change, B.s.pct_change),
    row('1 month', A.m1, B.m1),
    row('1 year', A.y1, B.y1),
    row('from 52-week high', A.fromHigh, B.fromHigh),
    row('RSI', A.rsi, B.rsi, (v) => v.toFixed(0)),
  ].filter(Boolean)
  let verdict = ''
  if (A.y1 != null && B.y1 != null) {
    verdict = Math.abs(A.y1 - B.y1) < 0.005 ? ' over the past year, they are about even.' : ` over the past year, ${A.y1 > B.y1 ? ta : tb} did better.`
  }
  return {
    text: `${ta} vs ${tb}. ${lines.join('; ')}.${verdict} past moves don't predict future ones.`,
    links: [link(A.s.symbol), link(B.s.symbol)],
    chips: [`open ${ta}`, `open ${tb}`, 'what is RSI?'],
  }
}

async function scanReply(scan, blurb) {
  const { results, as_of_date } = await getScan(scan, 5)
  const chips = SCANS.filter((x) => x[1] !== scan).map((x) => x[3])
  if (!results.length) return { text: `no company ${blurb} on ${as_of_date}. quiet day!`, chips }
  return {
    text: `${results.length} that ${blurb} on ${as_of_date}: ${results.map((r) => `${bare(r.symbol)} ${pct(r.pct)}`).join(', ')}. tap one, or see the full list in ✨ scans.`,
    links: results.map((r) => link(r.symbol)),
    chips,
  }
}

async function fundReply(query) {
  const words = query.replace(/\b(mutual|fund|funds|scheme|nav|of|the|returns?)\b/g, ' ').replace(/\s+/g, ' ').trim()
  let { results } = await searchFunds(query)
  if (!results.length && words) ({ results } = await searchFunds(words))
  if (!results.length) return { text: `i couldn't find a fund matching "${query}". try the fund house and name, like "parag parikh flexi cap".` }
  const f = await getFund(results[0].code)
  const title = f.name.split(/\s+-\s+/)[0]
  const r = f.returns
  const bits = [`${title} (${f.name.split(/\s+-\s+/).slice(1).join(', ').toLowerCase() || f.fund_house}) has a NAV of ₹${num(f.nav)} as of ${f.nav_date}.`]
  if (r['1y'] != null) bits.push(`it's ${pct(r['1y'])} over a year`)
  if (r['3y'] != null) bits.push(`${pct(r['3y'])} a year over 3 years`)
  if (r['5y'] != null) bits.push(`${pct(r['5y'])} a year over 5 years`)
  return {
    text: `${bits[0]}${bits.length > 1 ? ' ' + bits.slice(1).join(', ') + '.' : ''} past returns don't promise future ones.`,
    links: [{ label: title, fund: f.code }],
    chips: ['what is NAV?', 'what is CAGR?', 'direct or regular?'],
  }
}

// The chat's front door.
export async function replyAsync(input, ctx) {
  const raw = clean(input)
  const text = raw.toLowerCase()
  const wrap = (r) => (typeof r === 'string' ? { text: r, chips: DEFAULT_CHIPS } : { chips: DEFAULT_CHIPS, ...r })
  if (!text) return wrap(reply(input, ctx))
  if (ADVICE.test(text)) {
    return wrap("i can't tell you what to buy or sell. i'm not a financial advisor, just your watchlist bestie. i can tell you what changed and why, though!")
  }
  try {
    // actions on the watchlist
    let m = text.match(ADD)
    if (m && !/^(a |some |stocks?$)/.test(m[1])) {
      const hit = await findStock(m[1])
      if (!hit) return wrap(`i couldn't find a stock called "${m[1]}". try its NSE ticker, like TCS or INFY.`)
      const t = bare(hit.symbol)
      if (ctx.watchlist.some((w) => w.symbol === hit.symbol)) return wrap({ text: `${t} is already on your watchlist!`, links: [link(hit.symbol)] })
      return wrap({
        text: `added ${hit.name} (${t}) to your watchlist 💗 i'll keep an eye on it.`,
        links: [link(hit.symbol)],
        action: { type: 'add', symbol: hit.symbol },
        chips: [`tell me about ${t}`, 'how are my stocks?', `remove ${t}`],
      })
    }
    m = text.match(REMOVE)
    if (m) {
      const q = m[1].toUpperCase()
      let row = ctx.watchlist.find((w) => bare(w.symbol) === q)
      if (!row) {
        const hit = await findStock(m[1])
        row = hit && ctx.watchlist.find((w) => w.symbol === hit.symbol)
      }
      if (!row) return wrap(`${m[1].toUpperCase()} isn't on your watchlist, so nothing to remove.`)
      return wrap({ text: `removed ${bare(row.symbol)} from your watchlist. bye bye! 👋`, action: { type: 'remove', symbol: row.symbol } })
    }
    m = text.match(OPEN)
    if (m && !NOT_A_STOCK.has(m[1]) && !SKIP_OPEN.test(m[1])) {
      const hit = await findStock(m[1].replace(FILLER, '').trim())
      if (hit) {
        return wrap({
          text: `opening ${hit.name} (${bare(hit.symbol)}) for you ✨`,
          links: [link(hit.symbol)],
          action: { type: 'open', symbol: hit.symbol },
          chips: [`tell me about ${bare(hit.symbol)}`, `add ${bare(hit.symbol)}`],
        })
      }
    }

    const g = glossary(text)
    if (g) return wrap(g)

    m = text.match(COMPARE)
    if (m) return wrap(await compareReply((m[1] || m[3]).trim(), (m[2] || m[4]).trim()))

    const row = findSymbol(raw, ctx.watchlist)
    if (row) return wrap({ text: reply(input, ctx), links: [link(row.symbol)], chips: [`open ${bare(row.symbol)}`, `remove ${bare(row.symbol)}`, 'how are my stocks?'] })

    const scan = SCANS.find(([words]) => words.some((w) => text.includes(w)))
    if (scan) return wrap(await scanReply(scan[1], scan[2]))

    if (/\b(fund|funds|mutual|nav)\b/.test(text)) {
      const looked = text.match(LOOKUP)
      return wrap(await fundReply((looked ? looked[1] : text).trim()))
    }

    if (MARKET_WORDS.some((w) => text.includes(w))) return wrap(await marketReply(text))

    // "what is tcs share price" / "what's nykaa's price"
    const looked = text.match(LOOKUP) || text.match(/^(?:what(?:'s| is)|whats)\s+(?:the\s+)?(.+?)(?:'s)?\s+(?:share\s+|stock\s+)?price$/)
    let query = looked ? looked[1].replace(FILLER, '').replace(/\s+/g, ' ').trim() : null
    const fallback = reply(input, ctx)
    // a bare word or two ("tcs", "hdfc bank") the offline brain doesn't know
    if (!query && fallback.startsWith("hmm, i didn't catch that") && text.split(/\s+/).length <= 3) query = text
    if (query && query.length >= 2 && !NOT_A_STOCK.has(query)) {
      const hit = await findStock(query)
      if (hit) return wrap(await stockReply(hit, ctx.watchlist))
      if (looked) return wrap(`i couldn't find a stock called "${query}". try its NSE ticker, like TCS or INFY.`)
    }
    return wrap(fallback)
  } catch {
    return wrap("i couldn't reach the market data just now. try again in a moment?")
  }
}
