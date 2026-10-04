// First-visit welcome tour, guided by the mascot, plus the "install app"
// button. The tour runs once (remembered in this browser) and can be
// replayed from the ❓ button in the header.
import { useEffect, useState } from 'react'

const TOUR_KEY = 'signal-tour-v1'

const STEPS = [
  {
    target: null,
    title: 'hiii, welcome to signal! 💗',
    text: "i help total beginners understand the indian stock market. nothing here spends real money, so explore freely. let me show you around in 4 quick steps!",
  },
  {
    target: '.view-switcher',
    title: 'your tabs',
    text: 'my stocks = your watchlist · market = how india did today · scans = unusual stocks · funds = mutual funds · shop = practice investing.',
  },
  {
    target: '.point-learn',
    title: 'point & learn 🔍',
    text: "confused by a word like RSI or NAV? switch this on and tap anything. i'll explain it, and you can ask the AI for more.",
  },
  {
    target: '.view-switcher .lens-btn:last-child',
    title: 'the stock shop 🛍️',
    text: 'practice with ₹10,00,000 of pretend money: shop real brands like nykaa and zomato, take 1-minute lessons, earn badges.',
  },
  {
    target: '.mood-card',
    title: 'or just ask me 💬',
    text: 'type anything: "how\'s the market?", "tell me about TCS", "what is a SIP?". i explain things, i never tell you what to buy.',
  },
]

export function useTour(ready) {
  const [step, setStep] = useState(null)
  useEffect(() => {
    if (!ready) return
    let seen = false
    try {
      seen = localStorage.getItem(TOUR_KEY) === 'done'
    } catch {
      // storage blocked: treat as seen, don't nag every visit
      seen = true
    }
    if (!seen) setStep(0)
  }, [ready])
  const finish = () => {
    try {
      localStorage.setItem(TOUR_KEY, 'done')
    } catch {
      // storage blocked
    }
    setStep(null)
  }
  return { step, setStep, start: () => setStep(0), finish }
}

export function Tour({ step, setStep, finish }) {
  const s = step == null ? null : STEPS[step]

  useEffect(() => {
    if (!s?.target) return undefined
    const el = document.querySelector(s.target)
    if (!el) return undefined
    el.classList.add('tour-target')
    el.scrollIntoView({ block: 'center', behavior: 'smooth' })
    return () => el.classList.remove('tour-target')
  }, [s])

  useEffect(() => {
    if (step == null) return undefined
    const key = (e) => {
      if (e.key === 'Escape') finish()
      if (e.key === 'ArrowRight') step < STEPS.length - 1 ? setStep(step + 1) : finish()
      if (e.key === 'ArrowLeft' && step > 0) setStep(step - 1)
    }
    document.addEventListener('keydown', key)
    return () => document.removeEventListener('keydown', key)
  }, [step, setStep, finish])

  if (!s) return null
  const last = step === STEPS.length - 1
  return (
    <div className="tour-backdrop">
      <div className="tour-card" role="dialog" aria-label="welcome tour">
        <span className="learn-avatar tour-avatar" aria-hidden="true" />
        <div className="tour-body">
          <strong className="learn-title">{s.title}</strong>
          <p className="learn-text">{s.text}</p>
          <div className="tour-actions">
            <span className="tour-dots" aria-label={`step ${step + 1} of ${STEPS.length}`}>
              {STEPS.map((_, i) => (
                <i key={i} className={i === step ? 'on' : ''} />
              ))}
            </span>
            <button className="tour-skip" onClick={finish}>
              {last ? 'close' : 'skip'}
            </button>
            {step > 0 && (
              <button className="tour-back" onClick={() => setStep(step - 1)}>
                back
              </button>
            )}
            <button className="ask-ai-btn" onClick={() => (last ? finish() : setStep(step + 1))}>
              {last ? "let's go! ✨" : 'next'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

// "Install app": Chrome/Edge/Android offer a real install prompt; iPhones
// need Share → Add to Home Screen, so they get a short how-to instead.
export function InstallButton() {
  const [prompt, setPrompt] = useState(null)
  const [iosHelp, setIosHelp] = useState(false)
  const standalone = typeof window !== 'undefined' && (window.matchMedia?.('(display-mode: standalone)').matches || navigator.standalone)
  const ios = typeof navigator !== 'undefined' && /iphone|ipad|ipod/i.test(navigator.userAgent)

  useEffect(() => {
    const onPrompt = (e) => {
      e.preventDefault()
      setPrompt(e)
    }
    const onInstalled = () => setPrompt(null)
    window.addEventListener('beforeinstallprompt', onPrompt)
    window.addEventListener('appinstalled', onInstalled)
    return () => {
      window.removeEventListener('beforeinstallprompt', onPrompt)
      window.removeEventListener('appinstalled', onInstalled)
    }
  }, [])

  if (standalone || (!prompt && !ios)) return null
  return (
    <>
      <button
        className="learn-toggle install-btn"
        onClick={async () => {
          if (prompt) {
            prompt.prompt()
            await prompt.userChoice.catch(() => {})
            setPrompt(null)
          } else setIosHelp((v) => !v)
        }}
      >
        📲 install app
      </button>
      {iosHelp && (
        <div className="ios-help" role="note">
          on iPhone: tap the <strong>Share</strong> button in Safari, then <strong>Add to Home Screen</strong>. 💗
        </div>
      )}
    </>
  )
}
