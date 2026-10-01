// The mascot's chat brain. Free and offline: keyword intents answered in
// her voice from the app's live data -- no API calls, no model. Every
// number she says comes from the same watchlist/changed responses the
// rest of the page renders, so she can't contradict the screen.

const pct = (p) => (p == null ? null : `${p >= 0 ? '+' : ''}${(p * 100).toFixed(1)}%`)
const bare = (s) => s.replace(/\.NS$/, '')

const STALENESS_EXPLAIN = {
  live: 'live means the price is under 2 minutes old.',
  delayed: 'delayed means 2 to 15 minutes old, still fine for a glance.',
  stale: "stale means over 15 minutes old during market hours. i'd double-check before acting.",
  closed: "market closed means NSE is shut, so you're seeing the last close. that's the right price, not a lagging one.",
  unknown: "unknown means i couldn't get a fresh price at all, so i won't pretend i have one.",
}

export const QUICK_REPLIES = ['what changed?', 'how are my stocks?', 'what do the badges mean?', 'what is the quiet log?']

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
    return "i'm signal's mascot! ask me what changed, how your stocks are doing, about any stock on your list by name, or what the badges, quiet log and \"seen it\" mean."
  }

  return "hmm, i didn't catch that. i'm a simple bot! try one of the buttons below, or ask about a stock on your list by name."
}
