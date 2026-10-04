const BASE = '/api'

async function request(path, options = {}) {
  const res = await fetch(`${BASE}${path}`, {
    // 'include', not 'same-origin' -- verified empirically that
    // 'same-origin' does not reliably reattach signal_user_id on this
    // Vite-dev-proxy setup (every request kept minting a fresh cookie).
    // 'include' removes any origin-matching ambiguity outright.
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    ...options,
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`${options.method || 'GET'} ${path} failed: ${res.status} ${text}`)
  }
  if (res.status === 204) return null
  return res.json()
}

export const getWatchlist = () => request('/watchlist')

export const addSymbol = (symbol) =>
  request('/watchlist', { method: 'POST', body: JSON.stringify({ symbol }) })

export const removeSymbol = (symbol) =>
  request(`/watchlist/${encodeURIComponent(symbol)}`, { method: 'DELETE' })

export const getFeed = (lens) => request(`/feed?lens=${lens}`)

export const getChanged = () => request('/changed')

export const getQuietLog = () => request('/quiet-log')

export const getMarket = () => request('/market')

export const getScan = (scan, limit = 25) => request(`/scans/${encodeURIComponent(scan)}?limit=${limit}`)

export const searchSymbols = (q) => request(`/search?q=${encodeURIComponent(q)}`)

export const getStock = (symbol) => request(`/stock/${encodeURIComponent(symbol)}`)

export const ackSymbol = (symbol, seenUntil) =>
  request('/ack', {
    method: 'POST',
    body: JSON.stringify({ symbol, seen_until: seenUntil }),
  })

export const searchFunds = (q) => request(`/funds/search?q=${encodeURIComponent(q)}`)

export const getFund = (code) => request(`/funds/${encodeURIComponent(code)}`)

export const getQuotes = (symbols) => request(`/quotes?symbols=${encodeURIComponent(symbols.join(","))}`)

export const getBoutique = (symbols) => request(`/boutique?symbols=${encodeURIComponent(symbols.join(","))}`)
