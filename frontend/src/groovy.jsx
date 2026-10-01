// 70s "groovy retro script" headings. The lettering itself is pure CSS
// (.groovy-title / .groovy-tagline in index.css); this only wraps emoji in
// a span so the red outline and 3D extrusion skip them.

const EMOJI = /(\p{Extended_Pictographic}(?:️|‍\p{Extended_Pictographic})*)/u

export function GroovyText({ text }) {
  return text.split(EMOJI).map((part, i) =>
    i % 2 === 1 ? (
      <span key={i} className="groovy-emoji">
        {part}
      </span>
    ) : (
      part
    ),
  )
}
