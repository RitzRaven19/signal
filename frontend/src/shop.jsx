// The shop: learn investing by "shopping" for real companies with pretend
// money. Boutique aisles of brands you already know, a bag and checkout,
// your closet (the practice portfolio), bite-size lessons with quizzes,
// and badges.
//
// Design rules, from research on gamified investing (Ontario Securities
// Commission work on trading apps; Female Invest's Playvest simulator):
//   * reward learning, diversifying, holding and goals -- never the number
//     of trades (trade "points" raised trading ~40% in studies)
//   * no leaderboards, no countdowns, no confetti for buying
//   * describe, never recommend: vibe tags describe how much a price has
//     swung, not whether to buy
import { useEffect, useState } from 'react'
import { getBoutique, getQuotes } from './api'
import { GroovyText } from './groovy'
import { SkeletonCards } from './skeleton'
import { fmtPct, fmtPrice } from './market'
import { EXPLORED_KEY, ex } from './explain'
import { PortfolioView, buyInto, loadBook, saveBook } from './portfolio'

const bare = (s) => (s || '').replace(/\.NS$/, '')
const dir = (p) => (p == null ? 'flat' : p >= 0 ? 'up' : 'down')

// Real NSE companies behind brands people use every day. Blurbs say what
// the company does -- facts, not opinions.
export const AISLES = [
  {
    key: 'beauty',
    label: '💄 beauty & self-care',
    items: [
      ['NYKAA.NS', 'Nykaa: online beauty and fashion store'],
      ['HONASA.NS', 'Mamaearth, The Derma Co and more'],
      ['HINDUNILVR.NS', 'Dove, Lakmé, Pond’s, Surf Excel'],
      ['GODREJCP.NS', 'Godrej No.1 soap, Cinthol, hair colour'],
      ['DABUR.NS', 'Dabur Amla, Real juices, Vatika'],
      ['MARICO.NS', 'Parachute, Saffola, Set Wet'],
    ],
  },
  {
    key: 'fashion',
    label: '👗 fashion & jewellery',
    items: [
      ['TRENT.NS', 'Zudio and Westside stores'],
      ['TITAN.NS', 'Tanishq, Titan watches, CaratLane'],
      ['KALYANKJIL.NS', 'Kalyan Jewellers stores'],
      ['ABFRL.NS', 'Pantaloons, Allen Solly, Van Heusen'],
      ['PAGEIND.NS', 'Jockey innerwear in India'],
      ['METROBRAND.NS', 'Metro, Mochi and Crocs stores'],
    ],
  },
  {
    key: 'food',
    label: '🍕 food & cafés',
    items: [
      ['JUBLFOOD.NS', 'Domino’s Pizza in India'],
      ['WESTLIFE.NS', 'McDonald’s in west & south India'],
      ['DEVYANI.NS', 'KFC and Pizza Hut outlets'],
      ['TATACONSUM.NS', 'Tata Tea, Tata Salt, Starbucks India (JV)'],
      ['NESTLEIND.NS', 'Maggi, KitKat, Nescafé'],
      ['ETERNAL.NS', 'Zomato and Blinkit'],
      ['SWIGGY.NS', 'Swiggy and Instamart'],
    ],
  },
  {
    key: 'tech',
    label: '📱 tech & phones',
    items: [
      ['BHARTIARTL.NS', 'Airtel mobile and broadband'],
      ['DIXON.NS', 'makes phones and TVs for big brands'],
      ['INFY.NS', 'Infosys: IT services worldwide'],
      ['TCS.NS', 'TCS: India’s biggest IT services firm'],
    ],
  },
  {
    key: 'fun',
    label: '✈️ travel & fun',
    items: [
      ['INDIGO.NS', 'IndiGo airline'],
      ['INDHOTEL.NS', 'Taj hotels'],
      ['PVRINOX.NS', 'PVR INOX cinemas'],
      ['IRCTC.NS', 'train tickets and railway food'],
    ],
  },
  {
    key: 'money',
    label: '🏦 banks & money',
    items: [
      ['HDFCBANK.NS', 'HDFC Bank, India’s biggest private bank'],
      ['ICICIBANK.NS', 'ICICI Bank'],
      ['SBIN.NS', 'State Bank of India'],
      ['BAJFINANCE.NS', 'loans and EMIs on things you buy'],
    ],
  },
]
const AISLE_OF = Object.fromEntries(AISLES.flatMap((a) => a.items.map(([s]) => [s, a.key])))
const BLURB_OF = Object.fromEntries(AISLES.flatMap((a) => a.items))
// The brand people know, shown on the card; the legal name sits underneath.
export const BRAND_OF = {
  'NYKAA.NS': 'Nykaa',
  'HONASA.NS': 'Mamaearth',
  'HINDUNILVR.NS': 'Hindustan Unilever',
  'GODREJCP.NS': 'Godrej Consumer',
  'DABUR.NS': 'Dabur',
  'MARICO.NS': 'Marico',
  'TRENT.NS': 'Zudio & Westside',
  'TITAN.NS': 'Titan & Tanishq',
  'KALYANKJIL.NS': 'Kalyan Jewellers',
  'ABFRL.NS': 'Aditya Birla Fashion',
  'PAGEIND.NS': 'Jockey (Page Ind.)',
  'METROBRAND.NS': 'Metro Brands',
  'JUBLFOOD.NS': "Domino's (Jubilant)",
  'WESTLIFE.NS': "McDonald's (Westlife)",
  'DEVYANI.NS': 'KFC & Pizza Hut (Devyani)',
  'TATACONSUM.NS': 'Tata Consumer',
  'NESTLEIND.NS': 'Nestlé India',
  'ETERNAL.NS': 'Zomato & Blinkit',
  'SWIGGY.NS': 'Swiggy',
  'BHARTIARTL.NS': 'Airtel',
  'DIXON.NS': 'Dixon',
  'INFY.NS': 'Infosys',
  'TCS.NS': 'TCS',
  'INDIGO.NS': 'IndiGo',
  'INDHOTEL.NS': 'Taj (Indian Hotels)',
  'PVRINOX.NS': 'PVR INOX',
  'IRCTC.NS': 'IRCTC',
  'HDFCBANK.NS': 'HDFC Bank',
  'ICICIBANK.NS': 'ICICI Bank',
  'SBIN.NS': 'SBI',
  'BAJFINANCE.NS': 'Bajaj Finance',
}
const ALL_SYMBOLS = AISLES.flatMap((a) => a.items.map(([s]) => s))

// Brand icons: each company website's own icon, via Google's free favicon
// service (no logo files stored here). Checked Oct 2026; brands whose icon
// is missing or too small to look sharp (Dabur, IRCTC, Trent) use the letter.
const ICON_DOMAIN = {
  'NYKAA.NS': 'nykaa.com', 'HONASA.NS': 'mamaearth.in', 'HINDUNILVR.NS': 'hul.co.in', 'GODREJCP.NS': 'www.godrejcp.com',
  'MARICO.NS': 'marico.com', 'TITAN.NS': 'titan.co.in', 'KALYANKJIL.NS': 'kalyanjewellers.net', 'ABFRL.NS': 'abfrl.com',
  'PAGEIND.NS': 'jockey.in', 'METROBRAND.NS': 'metroshoes.com', 'JUBLFOOD.NS': 'dominos.co.in', 'WESTLIFE.NS': 'mcdonalds.com',
  'DEVYANI.NS': 'online.kfc.co.in', 'TATACONSUM.NS': 'tataconsumer.com', 'NESTLEIND.NS': 'nestle.in', 'ETERNAL.NS': 'zomato.com',
  'SWIGGY.NS': 'swiggy.com', 'BHARTIARTL.NS': 'airtel.in', 'DIXON.NS': 'dixoninfo.com', 'INFY.NS': 'infosys.com',
  'TCS.NS': 'www.tcs.com', 'INDIGO.NS': 'goindigo.in', 'INDHOTEL.NS': 'tajhotels.com', 'PVRINOX.NS': 'pvrcinemas.com',
  'HDFCBANK.NS': 'hdfcbank.com', 'ICICIBANK.NS': 'icicibank.com', 'SBIN.NS': 'onlinesbi.sbi', 'BAJFINANCE.NS': 'bajajfinserv.in',
}
const MIN_ICON_PX = 32

export function BrandLogo({ symbol, small = false }) {
  const [failed, setFailed] = useState(false)
  const domain = ICON_DOMAIN[symbol]
  const cls = small ? 'product-logo small' : 'product-logo'
  if (!domain || failed) {
    return (
      <span className={cls} aria-hidden="true">
        {bare(symbol)[0]}
      </span>
    )
  }
  return (
    <span className={`${cls} has-icon`} aria-hidden="true">
      <img
        src={`https://www.google.com/s2/favicons?domain=${domain}&sz=128`}
        alt=""
        loading="lazy"
        referrerPolicy="no-referrer"
        onError={() => setFailed(true)}
        onLoad={(e) => e.currentTarget.naturalWidth < MIN_ICON_PX && setFailed(true)}
      />
    </span>
  )
}

// How much the price has swung day to day (stdev of daily returns).
function vibe(dailyVol) {
  if (dailyVol == null) return null
  if (dailyVol < 0.015) return { tag: 'steady 🧸', tip: 'its price has moved calmly day to day lately' }
  if (dailyVol < 0.025) return { tag: 'bouncy 🎈', tip: 'its price moves around a fair bit day to day' }
  return { tag: 'spicy 🌶️', tip: 'its price has swung a lot day to day lately' }
}

// ── lessons ──────────────────────────────────────────────────────────

export const LESSONS = [
  {
    id: 'share',
    title: 'what is a share?',
    body: [
      'a company is split into millions of tiny pieces called shares.',
      'buy one share of Titan and you own a tiny slice of the whole company: its stores, its brands, its profits.',
      'if the company grows, your slice can become worth more. if it struggles, it can be worth less.',
    ],
    q: 'you own 1 share of Titan. what do you own?',
    options: ['a Titan watch', 'a tiny piece of the company', 'a loan you gave Titan'],
    answer: 1,
  },
  {
    id: 'move',
    title: 'why do prices move?',
    body: [
      'a share price is set by buyers and sellers every second the market is open.',
      'more people wanting to buy pushes it up; more wanting to sell pushes it down.',
      'news, results, the economy and plain mood all change what people want to pay.',
    ],
    q: 'lots more people want to sell a stock than buy it. the price usually…',
    options: ['goes up', 'goes down', 'stays exactly the same'],
    answer: 1,
  },
  {
    id: 'eggs',
    title: 'don’t put all your eggs in one basket',
    body: [
      'diversifying means owning different things, so one bad day for one company doesn’t sink everything.',
      'a closet with beauty, food, banks and tech is less fragile than one with five fashion brands.',
      'your closet shows a diversity score to help you see this.',
    ],
    q: 'which closet is more diversified?',
    options: ['5 jewellery brands', '1 bank, 1 food chain, 1 beauty brand, 1 tech firm', 'all your money in one stock'],
    answer: 1,
  },
  {
    id: 'vibe',
    title: 'steady vs spicy',
    body: [
      'some prices barely move day to day; others jump around a lot. that jumpiness is called volatility.',
      'spicy stocks can rise fast, and fall fast too. steady ones usually move less either way.',
      'the vibe tags in the boutique describe how a price has moved. they don’t say what’s good to buy.',
    ],
    q: 'a "spicy 🌶️" stock is one that…',
    options: ['is sure to go up', 'has swung a lot day to day lately', 'is a food company'],
    answer: 1,
  },
  {
    id: 'patience',
    title: 'time in the market',
    body: [
      'buying and selling within the same day (intraday trading) is really hard.',
      'SEBI found about 7 in 10 individual intraday traders in India lost money in FY2022-23.',
      'many long-term investors buy companies they understand and hold them for years.',
    ],
    q: 'what did SEBI find about individual intraday traders?',
    options: ['most made money', 'about 7 in 10 lost money', 'everyone broke even'],
    answer: 1,
  },
  {
    id: 'index',
    title: 'what is an index?',
    body: [
      'an index tracks a group of stocks as one number. NIFTY 50 follows 50 of India’s biggest companies.',
      'when people say "the market is up", they usually mean NIFTY 50 or SENSEX rose.',
      'an index fund buys everything in the index, so you own a little of all 50 at once.',
    ],
    q: 'NIFTY 50 is…',
    options: ['one big company', 'a number that tracks 50 big companies', 'a type of bank account'],
    answer: 1,
  },
  {
    id: 'sip',
    title: 'mutual funds & SIPs',
    body: [
      'a mutual fund pools money from many people and a manager invests it in lots of stocks or bonds.',
      'an SIP puts a fixed amount in every month automatically, so you buy more units when prices are low.',
      'you can look up any Indian fund in the 💰 funds tab.',
    ],
    q: 'an SIP is…',
    options: ['a fixed amount invested every month', 'a one-time lottery ticket', 'a kind of share'],
    answer: 0,
  },
  {
    id: 'scams',
    title: 'spot the scam',
    body: [
      'nobody can promise guaranteed returns from stocks. "double your money" is a red flag.',
      'be careful with stock tips in WhatsApp or Telegram groups. pump-and-dump schemes often start there.',
      'only invest through a SEBI-registered broker, and never share your OTP or password.',
    ],
    q: 'a group promises "guaranteed 30% a month". this is…',
    options: ['a great deal', 'a red flag', 'normal for stocks'],
    answer: 1,
  },
]

// ── progress (sparkles, lessons, streak, bag), saved in this browser ──

const SHOP_KEY = 'signal-shop-v1'
const SPARKLES_PER_LESSON = 10
const freshProgress = () => ({ bag: {}, lessons: {}, sparkles: 0, streak: { last: null, count: 0 } })

function loadProgress() {
  try {
    const p = JSON.parse(localStorage.getItem(SHOP_KEY))
    if (p && p.bag && p.lessons) return { ...freshProgress(), ...p }
  } catch {
    // storage blocked or corrupt -- start fresh
  }
  return freshProgress()
}

const dayKey = (d = new Date()) => d.toDateString()

// Things explored in point & learn mode (one sparkle each).
const exploredCount = () => {
  try {
    return (JSON.parse(localStorage.getItem(EXPLORED_KEY)) || []).length
  } catch {
    return 0
  }
}
const CURIOUS_TARGET = 15

// ── badges: earned for learning, spreading out and patience ──

function badgeList(book, progress, explored) {
  const holdings = Object.keys(book.holdings)
  const aisles = new Set(holdings.map((s) => AISLE_OF[s] || 'other'))
  const lessonsDone = Object.keys(progress.lessons).length
  const firstBuy = {}
  for (const t of [...book.trades].reverse()) if (t.side === 'buy' && !firstBuy[t.symbol]) firstBuy[t.symbol] = t.at
  const heldWeek = holdings.some((s) => firstBuy[s] && Date.now() - new Date(firstBuy[s]).getTime() >= 7 * 86400000)
  const values = holdings.map((s) => book.holdings[s].qty * book.holdings[s].cost)
  const total = values.reduce((a, v) => a + v, 0)
  const balanced = holdings.length >= 3 && values.every((v) => v / total <= 0.4)
  return [
    ['🎓', 'first lesson', 'finish any lesson', lessonsDone >= 1],
    ['🛍️', 'first purchase', 'check out your first bag', book.trades.some((t) => t.side === 'buy')],
    ['🌈', 'mix & match', 'own stocks from 3 different aisles', aisles.size >= 3],
    ['⚖️', 'balanced closet', 'own 3+ stocks with none over 40% of your closet', balanced],
    ['🐢', 'patient queen', 'keep a stock for 7 days', heldWeek],
    ['📚', 'bookworm', 'finish 4 lessons', lessonsDone >= 4],
    ['🔥', '3-day streak', 'learn something 3 days in a row', progress.streak.count >= 3],
    ['👑', 'money smart', 'finish every lesson', lessonsDone >= LESSONS.length],
    ['🌍', 'world tour', 'own stocks from 5 aisles', aisles.size >= 5],
    ['🔍', 'curious cat', `explore ${CURIOUS_TARGET} things in point & learn mode`, explored >= CURIOUS_TARGET],
  ]
}

// ── the view ─────────────────────────────────────────────────────────

const SUBTABS = [
  ['boutique', '🛍️ boutique'],
  ['bag', '👜 bag'],
  ['closet', '👚 my closet'],
  ['learn', '📚 learn'],
  ['badges', '🏅 badges'],
]

export function ShopView({ onOpen, initialPick = null, initialTab = 'boutique' }) {
  const [tab, setTab] = useState(initialPick ? 'closet' : initialTab)
  const [progress, setProgress] = useState(loadProgress)
  const [book, setBook] = useState(loadBook)

  useEffect(() => {
    if (initialPick) setTab('closet')
  }, [initialPick])

  useEffect(() => {
    try {
      localStorage.setItem(SHOP_KEY, JSON.stringify(progress))
    } catch {
      // storage blocked -- still works, just won't persist
    }
  }, [progress])

  // The closet edits the book on its own; re-read it whenever we leave it.
  useEffect(() => {
    if (tab !== 'closet') setBook(loadBook())
  }, [tab])

  const bagCount = Object.values(progress.bag).reduce((a, n) => a + n, 0)
  const explored = exploredCount()
  const sparkles = progress.sparkles + explored
  const badges = badgeList(book, progress, explored)
  const earned = badges.filter((b) => b[3]).length

  const addToBag = (symbol) =>
    setProgress((p) => ({ ...p, bag: { ...p.bag, [symbol]: (p.bag[symbol] || 0) + 1 } }))

  return (
    <>
      <section className="pane shop-head">
        <h2 className="groovy-title">
          <GroovyText text="🛍️ the stock shop" />
        </h2>
        <p className="inbox-subtitle">shop real companies with ₹10,00,000 of pretend money, and learn as you go.</p>
        <div className="shop-stats">
          <span className="glance-pill accent" {...ex('sparkles')}>✨ {sparkles} sparkles</span>
          <span className="glance-pill accent" {...ex('streak')}>🔥 {progress.streak.count}-day streak</span>
          <span className="glance-pill accent">🏅 {earned}/{badges.length} badges</span>
          <span className="glance-pill muted">cash {fmtPrice(book.cash)}</span>
        </div>
        <div className="lens-switcher shop-tabs">
          {SUBTABS.map(([key, label]) => (
            <button key={key} className={tab === key ? 'lens-btn active' : 'lens-btn'} onClick={() => setTab(key)}>
              {label}
              {key === 'bag' && bagCount > 0 && <span className="bag-count">{bagCount}</span>}
            </button>
          ))}
        </div>
      </section>

      {tab === 'boutique' && <Boutique onOpen={onOpen} onAdd={addToBag} bag={progress.bag} lessonsDone={progress.lessons} goLearn={() => setTab('learn')} />}
      {tab === 'bag' && (
        <Bag
          progress={progress}
          setProgress={setProgress}
          book={book}
          onCheckout={(next) => {
            saveBook(next)
            setBook(next)
          }}
          goShop={() => setTab('boutique')}
          goCloset={() => setTab('closet')}
        />
      )}
      {tab === 'closet' && (
        <>
          <Diversity book={book} />
          <PortfolioView onOpen={onOpen} initialPick={initialPick} />
        </>
      )}
      {tab === 'learn' && <Learn progress={progress} setProgress={setProgress} />}
      {tab === 'badges' && <Badges badges={badges} />}
    </>
  )
}

function Boutique({ onOpen, onAdd, bag, lessonsDone, goLearn }) {
  const [aisle, setAisle] = useState('beauty')
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  const [added, setAdded] = useState(null)

  useEffect(() => {
    getBoutique(ALL_SYMBOLS)
      .then(setData)
      .catch((e) => setError(e.message))
  }, [])

  const items = AISLES.find((a) => a.key === aisle).items
  const nudge = !lessonsDone.share ? 'new here? read "what is a share?" first. it takes a minute 💗' : null

  return (
    <section className="pane">
      <div className="lens-switcher scan-chips">
        {AISLES.map((a) => (
          <button key={a.key} className={aisle === a.key ? 'lens-btn active' : 'lens-btn'} onClick={() => setAisle(a.key)}>
            {a.label}
          </button>
        ))}
      </div>
      {nudge && (
        <button className="shop-nudge" onClick={goLearn}>
          📚 {nudge}
        </button>
      )}
      {error && <div className="error-banner">{error}</div>}
      {!data && !error ? (
        <SkeletonCards count={6} />
      ) : (
        data && (
          <>
            <div className="product-grid">
              {items.map(([symbol]) => {
                const it = data.items[symbol]
                const v = vibe(it?.daily_vol)
                return (
                  <article key={symbol} className="product-card">
                    <div className="product-top">
                      <BrandLogo symbol={symbol} />
                      {v && (
                        <span className="vibe-tag" title={v.tip} {...ex('vibe')}>
                          {v.tag}
                        </span>
                      )}
                    </div>
                    <h3 className="product-name">{BRAND_OF[symbol] || bare(symbol)}</h3>
                    <p className="product-legal">
                      {bare(symbol)} · {it?.name?.replace(/\s+(Limited|Ltd\.?)$/i, '') || ''}
                    </p>
                    <p className="product-blurb">{BLURB_OF[symbol]}</p>
                    <div className="product-price">
                      <strong>{fmtPrice(it?.close)}</strong>
                      <span className="product-unit" {...ex('per-share')}>per share</span>
                    </div>
                    <div className="product-moves">
                      <span className={`change ${dir(it?.pct)}`} {...ex('pct-day')}>{fmtPct(it?.pct)} day</span>
                      <span className={`change ${dir(it?.pct_1m)}`} {...ex('pct-1m')}>{fmtPct(it?.pct_1m)} 1m</span>
                    </div>
                    <div className="product-actions">
                      <button className="product-peek" onClick={() => onOpen(symbol)}>
                        peek 👀
                      </button>
                      <button
                        className="product-add"
                        onClick={() => {
                          onAdd(symbol)
                          setAdded(symbol)
                        }}
                      >
                        {bag[symbol] ? `in bag (${bag[symbol]}) +` : 'add to bag 👜'}
                      </button>
                    </div>
                  </article>
                )
              })}
            </div>
            {added && <p className="paper-note">added 1 share of {bare(added)} to your bag. open 👜 bag to check out.</p>}
            <p className="notice-asof">
              prices are the last close ({data.as_of_date}); checkout uses the latest price. vibe tags describe past price swings, they aren&apos;t advice.
            </p>
          </>
        )
      )}
    </section>
  )
}

function Bag({ progress, setProgress, book, onCheckout, goShop, goCloset }) {
  const symbols = Object.keys(progress.bag)
  const [quotes, setQuotes] = useState({})
  const [msg, setMsg] = useState(null)
  const key = symbols.sort().join(',')

  useEffect(() => {
    if (!key) return
    getQuotes(key.split(','))
      .then((d) => setQuotes(d.quotes))
      .catch(() => setMsg("couldn't fetch the latest prices. try again in a moment."))
  }, [key])

  const setQty = (s, n) =>
    setProgress((p) => {
      const bag = { ...p.bag }
      if (n <= 0) delete bag[s]
      else bag[s] = n
      return { ...p, bag }
    })

  const lines = symbols.map((s) => ({ s, n: progress.bag[s], price: quotes[s]?.price ?? null }))
  const priced = lines.length > 0 && lines.every((l) => l.price != null)
  const total = lines.reduce((a, l) => a + (l.price ?? 0) * l.n, 0)

  const checkout = () => {
    if (!priced) return
    if (total > book.cash) {
      setMsg(`that's ${fmtPrice(total)} and you have ${fmtPrice(book.cash)} of pretend cash. take something out?`)
      return
    }
    const next = lines.reduce((b, l) => buyInto(b, l.s, l.n, l.price), book)
    onCheckout(next)
    setProgress((p) => ({ ...p, bag: {} }))
    setMsg(`checked out ${lines.length} stock${lines.length > 1 ? 's' : ''} for ${fmtPrice(total)} 💗 they're in your closet now.`)
  }

  return (
    <section className="pane">
      <h2 className="groovy-title">
        <GroovyText text="👜 your bag" />
      </h2>
      {lines.length === 0 ? (
        <>
          <p className="empty">{msg || 'your bag is empty.'}</p>
          <div className="product-actions">
            <button className="product-add" onClick={goShop}>
              browse the boutique 🛍️
            </button>
            {msg && (
              <button className="product-peek" onClick={goCloset}>
                see my closet 👚
              </button>
            )}
          </div>
        </>
      ) : (
        <>
          <ul className="mkt-list">
            {lines.map((l) => (
              <li key={l.s} className="bag-line">
                <BrandLogo symbol={l.s} small />
                <div className="mkt-id">
                  <span className="symbol">{BRAND_OF[l.s] || bare(l.s)}</span>
                  <span className="mkt-name">{bare(l.s)} · {BLURB_OF[l.s] || ''}</span>
                </div>
                <div className="qty-stepper">
                  <button onClick={() => setQty(l.s, l.n - 1)} aria-label={`one less ${bare(l.s)}`}>
                    −
                  </button>
                  <span>{l.n}</span>
                  <button onClick={() => setQty(l.s, l.n + 1)} aria-label={`one more ${bare(l.s)}`}>
                    +
                  </button>
                </div>
                <span className="price bag-price">{l.price != null ? fmtPrice(l.price * l.n) : '…'}</span>
              </li>
            ))}
          </ul>
          <div className="bag-total">
            <span>total</span>
            <strong>{priced ? fmtPrice(total) : 'getting prices…'}</strong>
            <span className="paper-sub">cash after: {priced ? fmtPrice(book.cash - total) : '—'}</span>
          </div>
          <button className="ack-btn paper-buy checkout-btn" onClick={checkout} disabled={!priced}>
            check out (pretend money) 💳
          </button>
          {msg && <p className="paper-note">{msg}</p>}
        </>
      )}
    </section>
  )
}

function Diversity({ book }) {
  const holdings = Object.keys(book.holdings)
  if (!holdings.length) return null
  const byAisle = {}
  let total = 0
  for (const s of holdings) {
    const v = book.holdings[s].qty * book.holdings[s].cost
    const a = AISLE_OF[s] || 'other'
    byAisle[a] = (byAisle[a] || 0) + v
    total += v
  }
  const aisles = Object.keys(byAisle)
  const label = (k) => AISLES.find((a) => a.key === k)?.label || '✨ other'
  const score = Math.min(5, aisles.length)
  return (
    <section className="pane">
      <h2 className="groovy-title">
        <GroovyText text="🌈 closet mix" />
      </h2>
      <p className="diversity-score" {...ex('diversity')}>
        diversity: {'💗'.repeat(score)}
        {'🤍'.repeat(5 - score)} <span className="paper-sub">({aisles.length} aisle{aisles.length > 1 ? 's' : ''})</span>
      </p>
      <div className="mix-bar" role="img" aria-label="closet mix by aisle">
        {aisles.map((a, i) => (
          <span key={a} className={`mix-seg mix-${i % 6}`} style={{ width: `${(byAisle[a] / total) * 100}%` }} title={label(a)} />
        ))}
      </div>
      <ul className="mix-legend">
        {aisles.map((a, i) => (
          <li key={a}>
            <i className={`mix-dot mix-${i % 6}`} /> {label(a)} {Math.round((byAisle[a] / total) * 100)}%
          </li>
        ))}
      </ul>
      {aisles.length < 3 && <p className="paper-sub">tip: closets with a few different aisles are less fragile. see the lesson "don’t put all your eggs in one basket".</p>}
    </section>
  )
}

function Learn({ progress, setProgress }) {
  const [open, setOpen] = useState(null)
  const [picked, setPicked] = useState(null)
  const [earnedNow, setEarnedNow] = useState(false)
  const lesson = LESSONS.find((l) => l.id === open)

  const answer = (i) => {
    setPicked(i)
    if (i !== lesson.answer || progress.lessons[lesson.id]) return
    setEarnedNow(true)
    setProgress((p) => {
      const today = dayKey()
      const yesterday = dayKey(new Date(Date.now() - 86400000))
      const streak =
        p.streak.last === today ? p.streak : { last: today, count: p.streak.last === yesterday ? p.streak.count + 1 : 1 }
      return { ...p, lessons: { ...p.lessons, [lesson.id]: true }, sparkles: p.sparkles + SPARKLES_PER_LESSON, streak }
    })
  }

  if (lesson) {
    return (
      <section className="pane">
        <button className="lens-btn" onClick={() => (setOpen(null), setPicked(null), setEarnedNow(false))}>
          ← all lessons
        </button>
        <h2 className="groovy-title lesson-title">
          <GroovyText text={lesson.title} />
        </h2>
        {lesson.body.map((p) => (
          <p key={p} className="lesson-text">
            {p}
          </p>
        ))}
        <div className="quiz">
          <p className="quiz-q">🧠 {lesson.q}</p>
          {lesson.options.map((o, i) => (
            <button
              key={o}
              className={`quiz-option${picked === i ? (i === lesson.answer ? ' right' : ' wrong') : ''}`}
              onClick={() => answer(i)}
            >
              {o}
            </button>
          ))}
          {picked != null && (
            <p className="paper-note">
              {picked === lesson.answer
                ? earnedNow
                  ? `yes! +${SPARKLES_PER_LESSON} sparkles ✨`
                  : 'yes! (you already earned these sparkles)'
                : 'not quite, try another one 💗'}
            </p>
          )}
        </div>
      </section>
    )
  }

  const doneCount = Object.keys(progress.lessons).length
  return (
    <section className="pane">
      <h2 className="groovy-title">
        <GroovyText text="📚 learn" />
      </h2>
      <p className="inbox-subtitle">
        {doneCount}/{LESSONS.length} done · each lesson is a minute, with one quiz question. +{SPARKLES_PER_LESSON} sparkles each.
      </p>
      <ul className="lesson-list">
        {LESSONS.map((l, i) => (
          <li key={l.id}>
            <button className={progress.lessons[l.id] ? 'lesson-card done' : 'lesson-card'} onClick={() => setOpen(l.id)}>
              <span className="lesson-num">{progress.lessons[l.id] ? '✓' : i + 1}</span>
              {l.title}
            </button>
          </li>
        ))}
      </ul>
    </section>
  )
}

function Badges({ badges }) {
  return (
    <section className="pane">
      <h2 className="groovy-title">
        <GroovyText text="🏅 badges" />
      </h2>
      <p className="inbox-subtitle">earned by learning, spreading out and being patient. never by trading a lot.</p>
      <div className="badge-grid">
        {badges.map(([emoji, name, how, got]) => (
          <div key={name} className={got ? 'badge-card got' : 'badge-card'}>
            <span className="badge-emoji">{got ? emoji : '🔒'}</span>
            <strong>{name}</strong>
            <span className="paper-sub">{how}</span>
          </div>
        ))}
      </div>
    </section>
  )
}

