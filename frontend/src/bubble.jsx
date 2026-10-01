// "Bubble heart" lettering for headings: each letter is its own span so it
// can take a pink from the cycle, a gloss highlight and, now and then, a
// tiny heart (all drawn in CSS -- see .bl in index.css).
//
// Screen readers get the plain text once, from a visually hidden copy; the
// decorated letters are aria-hidden. (aria-label alone isn't read on a <p>
// or <span> by most screen readers, so it can't carry the tagline.)

const PINKS = ['#E8457A', '#F27BA6', '#F6B3CF', '#D93A6B']
const DESCENDERS = new Set(['g', 'j', 'p', 'q', 'y'])
const LETTER = /^[\p{L}\p{N}]$/u

// Grapheme clusters, so an emoji like ⛰️ (two code points) stays whole.
const segment = (text) =>
  typeof Intl !== 'undefined' && Intl.Segmenter
    ? Array.from(new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(text), (s) => s.segment)
    : Array.from(text)

export function BubbleText({ text }) {
  const parts = segment(text)
  let n = -1 // letter index: drives color, heart and bounce stagger
  return (
    <>
      <span className="sr-only">{text}</span>
      <span aria-hidden="true">
        {parts.map((ch, i) => {
          if (!LETTER.test(ch) && !/^[()'.,!?&-]$/.test(ch)) return ch // spaces and emoji stay as-is
          n += 1
          const isLetter = LETTER.test(ch)
          const heart =
            isLetter &&
            n % 3 === 2 &&
            !DESCENDERS.has(ch.toLowerCase()) &&
            LETTER.test(parts[i - 1] ?? '') &&
            LETTER.test(parts[i + 1] ?? '')
          const style = {
            '--c': PINKS[n % 4],
            '--i': n,
            '--r': `${((n * 7) % 31) - 15}deg`,
          }
          const cls = ['bl', !isLetter && 'bl-punct', heart && 'bl-heart'].filter(Boolean).join(' ')
          return (
            <span key={i} className={cls} style={style}>
              {ch}
            </span>
          )
        })}
      </span>
    </>
  )
}
