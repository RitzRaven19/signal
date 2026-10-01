// 70s "groovy retro script" headings. The lettering itself is pure CSS
// (.groovy-title / .groovy-tagline in index.css); this only wraps emoji in
// a span so the red outline and 3D extrusion skip them.

const EMOJI = /(\p{Extended_Pictographic}(?:️|‍\p{Extended_Pictographic})*)/u

// The full-screen loader in miniature, for loading inside a tab or sheet:
// the message in groovy lettering and the bunny running its bar.
export function MiniLoader({ text }) {
  return (
    <div className="mini-loader" role="status" aria-live="polite">
      <div className="mini-loader-title">
        <GroovyText text={text} />
      </div>
      <div className="loading-track mini-loader-track">
        <div className="loading-fill" />
        <div className="loading-runner">
          <div className="bunny">
            <span className="ear ear-l" />
            <span className="ear ear-r" />
            <span className="bunny-face">• ᴗ •</span>
          </div>
        </div>
      </div>
    </div>
  )
}

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
