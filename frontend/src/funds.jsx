// Mutual funds (Groww's other half): search any Indian fund, see its NAV
// chart and returns. Data is AMFI's daily NAVs via mfapi.in, proxied and
// cached by our API -- free, no key.
import { useEffect, useState } from 'react'
import { getFund, searchFunds } from './api'
import { FUND_RANGES, PriceChart, fmtPct } from './market'
import { ex } from './explain'
import { GroovyText, MiniLoader } from './groovy'

const dir = (p) => (p == null ? 'flat' : p >= 0 ? 'up' : 'down')
const fmtNav = (n) => (n == null ? '—' : `₹${n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`)

const STARTERS = [
  ['📊', 'nifty 50 index'],
  ['🌈', 'flexi cap'],
  ['🐣', 'small cap'],
  ['🏔️', 'large cap'],
  ['🧾', 'elss tax saver'],
  ['🪙', 'gold'],
  ['💧', 'liquid'],
]

// "Parag Parikh Flexi Cap Fund - Direct Plan - Growth" -> title + plan tags.
function splitName(name) {
  const [title, ...rest] = name.split(/\s+-\s+/)
  return { title, tags: rest }
}

export function FundsView({ onOpen }) {
  const [q, setQ] = useState('')
  const [submitted, setSubmitted] = useState('')
  const [results, setResults] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    if (submitted.trim().length < 2) return
    let live = true
    setResults(null)
    setError(null)
    searchFunds(submitted)
      .then((d) => live && setResults(d.results))
      .catch((e) => live && setError(e.message))
    return () => {
      live = false
    }
  }, [submitted])

  const go = (text) => {
    setQ(text)
    setSubmitted(text)
  }

  return (
    <section className="pane">
      <h2 className="groovy-title"><GroovyText text={'💰 mutual funds'} /></h2>
      <form
        className="add-form"
        onSubmit={(e) => {
          e.preventDefault()
          go(q)
        }}
      >
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="search a fund or fund house... 🔍" aria-label="search funds" />
        <button type="submit">search</button>
      </form>
      <div className="lens-switcher scan-chips">
        {STARTERS.map(([emoji, term]) => (
          <button key={term} className={submitted === term ? 'lens-btn active' : 'lens-btn'} onClick={() => go(term)}>
            {emoji} {term}
          </button>
        ))}
      </div>
      {error && <div className="error-banner">{error}</div>}
      {!submitted ? (
        <p className="inbox-subtitle">pick a starter above or search any fund. every Indian mutual fund is here, with its full NAV history.</p>
      ) : !results && !error ? (
        <MiniLoader text="looking through every scheme…" />
      ) : results?.length === 0 ? (
        <div className="notice-card">
          <p className="notice-headline">🌸 no funds matched</p>
          <p className="notice-body">try a shorter name, like "axis bluechip" or just the fund house.</p>
        </div>
      ) : (
        results && (
          <ul className="mkt-list">
            {results.map((f) => {
              const { title, tags } = splitName(f.name)
              return (
                <li key={f.code} className="mkt-row" tabIndex={0} onClick={() => onOpen(f.code)} onKeyDown={(e) => e.key === 'Enter' && onOpen(f.code)}>
                  <div className="mkt-id">
                    <span className="symbol fund-title">{title}</span>
                    <span className="fund-tags">
                      {tags.map((t) => (
                        <em key={t} {...ex(/direct|regular/i.test(t) ? 'fund-plan' : undefined)}>{t.toLowerCase()}</em>
                      ))}
                    </span>
                  </div>
                  <span className="mkt-extra">view ›</span>
                </li>
              )
            })}
          </ul>
        )
      )}
      <p className="notice-asof">tip: "direct" plans skip the distributor fee, so the same fund's direct plan usually returns a bit more than "regular".</p>
    </section>
  )
}

const RETURN_CELLS = [
  ['1m', '1 month'],
  ['3m', '3 months'],
  ['6m', '6 months'],
  ['1y', '1 year'],
  ['3y', '3 years', true],
  ['5y', '5 years', true],
  ['since_launch', 'since launch', true],
]

export function FundSheet({ code, onClose }) {
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    let live = true
    setData(null)
    setError(null)
    getFund(code)
      .then((d) => live && setData(d))
      .catch((e) => live && setError(e.message))
    const onKey = (e) => e.key === 'Escape' && onClose()
    document.addEventListener('keydown', onKey)
    return () => {
      live = false
      document.removeEventListener('keydown', onKey)
    }
  }, [code, onClose])

  // A NAV more than a week old usually means the scheme was merged or wound up.
  const stale = data && Date.now() - new Date(data.nav_date).getTime() > 7 * 86400000
  const name = data ? splitName(data.name) : null

  return (
    <div className="sheet-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="pane sheet" role="dialog" aria-label="fund details">
        <button className="chat-close sheet-close" onClick={onClose} aria-label="close">
          ×
        </button>
        {error ? (
          <div className="notice-card">
            <p className="notice-headline">🥺 couldn't load this fund</p>
            <p className="notice-body">{error}</p>
          </div>
        ) : !data ? (
          <MiniLoader text="loading the fund's NAV history…" />
        ) : (
          <>
            <div className="sheet-head">
              <div>
                <h2 className="fund-sheet-title">{name.title}</h2>
                <p className="mkt-name">
                  {data.fund_house}
                  {name.tags.length > 0 && ` · ${name.tags.join(' · ').toLowerCase()}`}
                </p>
              </div>
            </div>
            <div className="fund-chips">
              {data.category && <span className="event-type-chip">{data.category.replace(/^.*? - /, '').toLowerCase()}</span>}
              {data.type && <span className="glance-pill muted">{data.type.toLowerCase()}</span>}
            </div>
            <div className="sheet-price">
              <span className="big-price" {...ex('nav')}>{fmtNav(data.nav)}</span>
              <span className={`change ${dir(data.day_change)}`}>{fmtPct(data.day_change)} day</span>
              <span className="badge badge-closed">NAV of {new Date(data.nav_date).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}</span>
            </div>
            {stale && (
              <div className="error-banner">
                no new NAV for over a week. this scheme may have been merged or closed, so check with the fund house.
              </div>
            )}

            <PriceChart bars={data.bars} ranges={FUND_RANGES} defaultRange="1y" withAverages={false} />

            <h3 className="sheet-sub">📅 returns</h3>
            <div className="returns fund-returns">
              {RETURN_CELLS.map(([key, label, annual]) => (
                <div key={key} className="return-cell" {...ex(annual ? 'cagr' : 'returns')}>
                  <span className="return-label">{label}</span>
                  <span className={`change ${dir(data.returns[key])}`}>{fmtPct(data.returns[key])}</span>
                  {annual && <span className="return-sub">per year</span>}
                </div>
              ))}
            </div>
            <p className="tech-note">
              up to 1 year is total growth; 3 years and beyond are per-year averages (CAGR). launched{' '}
              {new Date(data.launched).toLocaleDateString('en-IN', { month: 'short', year: 'numeric' })} (or when AMFI's records begin). past returns don't promise future ones.
            </p>
          </>
        )}
      </div>
    </div>
  )
}
