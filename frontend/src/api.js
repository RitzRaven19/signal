const BASE = '/api'

async function request(path, options = {}) {
  const res = await fetch(`${BASE}${path}`, {
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

export const ackSymbol = (symbol, seenUntil) =>
  request('/ack', {
    method: 'POST',
    body: JSON.stringify({ symbol, seen_until: seenUntil }),
  })
