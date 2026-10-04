// Regression tests for the frontend's logic. Run: npm test
import { readFileSync, readdirSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { EXPLAIN } from './explain'
import { periodReturn, rsi, sma } from './market'
import { reply } from './mascotChat'
import { START_CASH, buyInto } from './portfolio'
import { AISLES, LESSONS } from './shop'

const ctx = { watchlist: [], changed: null, mood: 'cat' }
const ADVICE = "i can't tell you what to buy or sell"

describe('mascot chat', () => {
  it('refuses buy/sell advice', () => {
    expect(reply('should i buy tcs', ctx)).toContain(ADVICE)
    expect(reply('any tips?', ctx)).toContain(ADVICE)
  })

  it('does not mistake words that merely contain "tip" for advice', () => {
    // bug: "multiple" contains "tip" and triggered the refusal
    expect(reply('multiple stocks?', ctx)).not.toContain(ADVICE)
    expect(reply('what about stipend', ctx)).not.toContain(ADVICE)
  })

  it('no longer tells people to type .NS symbols', () => {
    expect(reply('how are my stocks?', ctx)).not.toContain('RELIANCE.NS')
  })
})

describe('chart maths', () => {
  it('sma is null until enough points, then the running mean', () => {
    expect(sma([1, 2, 3, 4], 3)).toEqual([null, null, 2, 3])
  })

  it('rsi is 100 for a straight rise and lower when it falls', () => {
    const up = Array.from({ length: 30 }, (_, i) => 100 + i)
    expect(rsi(up)).toBe(100)
    const down = Array.from({ length: 30 }, (_, i) => 100 - i)
    expect(rsi(down)).toBeLessThan(1)
    expect(rsi([1, 2, 3])).toBeNull() // not enough history
  })

  it('periodReturn compares with the close n sessions ago', () => {
    expect(periodReturn([100, 105, 110], 2)).toBeCloseTo(0.1)
    expect(periodReturn([100, 110], 5)).toBeNull()
  })
})

describe('practice portfolio', () => {
  const fresh = { cash: START_CASH, realized: 0, holdings: {}, trades: [] }

  it('buying spends cash and records the trade', () => {
    const b = buyInto(fresh, 'TCS.NS', 10, 2000)
    expect(b.cash).toBe(START_CASH - 20000)
    expect(b.holdings['TCS.NS']).toEqual({ qty: 10, cost: 2000 })
    expect(b.trades[0]).toMatchObject({ symbol: 'TCS.NS', side: 'buy', qty: 10, price: 2000 })
  })

  it('buying more blends the average cost', () => {
    const b = buyInto(buyInto(fresh, 'TCS.NS', 10, 2000), 'TCS.NS', 10, 1000)
    expect(b.holdings['TCS.NS']).toEqual({ qty: 20, cost: 1500 })
  })
})

describe('shop content', () => {
  it('every boutique symbol appears once and is an NSE ticker', () => {
    const syms = AISLES.flatMap((a) => a.items.map(([s]) => s))
    expect(new Set(syms).size).toBe(syms.length)
    syms.forEach((s) => expect(s).toMatch(/^[A-Z0-9&-]+\.NS$/))
  })

  it('every lesson quiz has a valid answer', () => {
    LESSONS.forEach((l) => {
      expect(l.options[l.answer]).toBeTruthy()
      expect(new Set(LESSONS.map((x) => x.id)).size).toBe(LESSONS.length)
    })
  })
})

describe('point & learn', () => {
  it('every ex("key") used in the app has an explanation', () => {
    const dir = new URL('.', import.meta.url)
    const used = new Set()
    for (const f of readdirSync(dir).filter((n) => /\.jsx$/.test(n))) {
      const src = readFileSync(new URL(f, dir), 'utf8')
      for (const m of src.matchAll(/ex\('([a-z0-9-]+)'\)/g)) used.add(m[1])
    }
    expect(used.size).toBeGreaterThan(20)
    const missing = [...used].filter((k) => !EXPLAIN[k])
    expect(missing).toEqual([])
  })
})
