// Signal's mascot: an original chibi drawn as SVG, so every part can move.
// Replaces the earlier photo assets, which were another artist's work.
// Moods: happy (wink + open smile), neutral (soft smile), confused
// (side-glance, wavy mouth, sweat drop, "?"), cat (eyes closed, cat mouth,
// a kitten peeking in -- shown while the watchlist is empty).

const INK = '#3b1f2b'
const HAIR = '#f6a5c0'
const HAIR_SHADE = '#e4819f'
const SKIN = '#ffe9df'
const BLOUSE = '#fbc8d8'
const IRIS = '#e65c8f'

function OpenEye({ cx, glance = 0 }) {
  return (
    <g>
      <ellipse cx={cx} cy={104} rx={9.5} ry={11.5} fill={INK} />
      <ellipse cx={cx + glance} cy={105.5} rx={7} ry={9} fill={IRIS} />
      <ellipse cx={cx + glance} cy={108.5} rx={4.5} ry={5} fill="#b8336a" />
      <circle cx={cx + glance - 3} cy={100.5} r={3} fill="#fff" />
      <circle cx={cx + glance + 3} cy={109} r={1.5} fill="#fff" />
      <path d={`M${cx - 11} ${96} Q${cx} ${88} ${cx + 11} ${96}`} stroke={INK} strokeWidth={3} fill="none" strokeLinecap="round" />
    </g>
  )
}

const ClosedEye = ({ cx, up = true }) => (
  <path
    d={up ? `M${cx - 9} 106 Q${cx} 97 ${cx + 9} 106` : `M${cx - 9} 102 Q${cx} 110 ${cx + 9} 102`}
    stroke={INK}
    strokeWidth={3.5}
    fill="none"
    strokeLinecap="round"
  />
)

function Eyes({ mood }) {
  if (mood === 'cat') {
    return (
      <>
        <ClosedEye cx={80} />
        <ClosedEye cx={120} />
      </>
    )
  }
  if (mood === 'happy') {
    return (
      <>
        <g className="chibi-blink">
          <OpenEye cx={80} />
        </g>
        <ClosedEye cx={120} />
      </>
    )
  }
  return (
    <g className="chibi-blink">
      <OpenEye cx={80} glance={mood === 'confused' ? -2.5 : 0} />
      <OpenEye cx={120} glance={mood === 'confused' ? -2.5 : 0} />
    </g>
  )
}

function Mouth({ mood }) {
  const shape = {
    happy: <path d="M90 121 Q100 137 110 121 Z" fill="#c2405f" stroke={INK} strokeWidth={2.5} strokeLinejoin="round" />,
    neutral: <path d="M93 123 Q100 129 107 123" stroke={INK} strokeWidth={2.8} fill="none" strokeLinecap="round" />,
    confused: (
      <path d="M90 126 Q95 121 100 126 Q105 131 110 126" stroke={INK} strokeWidth={2.8} fill="none" strokeLinecap="round" />
    ),
    cat: <path d="M91 122 Q95.5 128 100 122 Q104.5 128 109 122" stroke={INK} strokeWidth={2.8} fill="none" strokeLinecap="round" />,
  }[mood]
  return <g className="chibi-mouth">{shape}</g>
}

export default function Chibi({ mood = 'neutral', talking = false }) {
  return (
    <svg
      viewBox="0 0 200 200"
      className={talking ? 'chibi talking' : 'chibi'}
      role="img"
      aria-label={`Signal mascot, ${mood}`}
    >
      {/* twin tails, behind everything; each sways from its tie */}
      <g className="chibi-tail chibi-tail-l">
        <path d="M46 70 C24 92 22 142 34 184 C40 193 52 189 51 178 C46 140 52 102 62 84 Z" fill={HAIR} stroke={INK} strokeWidth={3} />
        <path d="M40 110 C36 136 38 160 44 178" stroke={HAIR_SHADE} strokeWidth={3} fill="none" strokeLinecap="round" />
      </g>
      <g className="chibi-tail chibi-tail-r">
        <path d="M154 70 C176 92 178 142 166 184 C160 193 148 189 149 178 C154 140 148 102 138 84 Z" fill={HAIR} stroke={INK} strokeWidth={3} />
        <path d="M160 110 C164 136 162 160 156 178" stroke={HAIR_SHADE} strokeWidth={3} fill="none" strokeLinecap="round" />
      </g>

      {/* back of the hair */}
      {/* fill and outline drawn separately: no outline along the bottom
          edge, which would show as a hard line beside her cheeks */}
      <path d="M40 102 C34 52 68 26 100 26 C132 26 166 52 160 102 L158 150 L42 150 Z" fill={HAIR} />
      <path d="M42 150 L40 102 C34 52 68 26 100 26 C132 26 166 52 160 102 L158 150" fill="none" stroke={INK} strokeWidth={3} />

      {/* shoulders: blouse, collar, bow */}
      <path d="M48 200 C50 168 70 150 100 150 C130 150 150 168 152 200 Z" fill={BLOUSE} stroke={INK} strokeWidth={3} />
      <rect x={92} y={136} width={16} height={18} fill={SKIN} />
      <path d="M100 154 L84 152 L92 172 Z M100 154 L116 152 L108 172 Z" fill="#fff" stroke={INK} strokeWidth={2.5} strokeLinejoin="round" />
      <path d="M100 162 L88 156 L88 170 Z M100 162 L112 156 L112 170 Z" fill={INK} />
      <circle cx={100} cy={162} r={3.5} fill={INK} />

      {/* face */}
      <ellipse cx={100} cy={97} rx={52} ry={48} fill={SKIN} stroke={INK} strokeWidth={3} />
      <ellipse cx={70} cy={118} rx={9} ry={5} fill="#ff9fb8" opacity={0.65} />
      <ellipse cx={130} cy={118} rx={9} ry={5} fill="#ff9fb8" opacity={0.65} />
      <Eyes mood={mood} />
      <Mouth mood={mood} />

      {/* bangs and side locks over the forehead */}
      <path
        d="M48 94 C44 52 74 38 100 38 C126 38 156 52 152 94 C147 79 140 70 132 65 C128 80 120 87 111 85 C114 75 112 66 108 61 C100 78 86 85 73 83 C77 75 80 68 80 63 C70 72 58 81 48 94 Z"
        fill={HAIR}
        stroke={INK}
        strokeWidth={3}
        strokeLinejoin="round"
      />
      <path d="M50 88 C45 110 47 128 54 142 C59 128 59 110 59 96 Z" fill={HAIR} stroke={INK} strokeWidth={3} strokeLinejoin="round" />
      <path d="M150 88 C155 110 153 128 146 142 C141 128 141 110 141 96 Z" fill={HAIR} stroke={INK} strokeWidth={3} strokeLinejoin="round" />
      <path d="M70 52 C82 45 96 43 112 45" stroke="#fff" strokeWidth={4} opacity={0.7} fill="none" strokeLinecap="round" />

      {/* black ribbons where the tails are tied */}
      {[46, 154].map((x) => (
        <g key={x} transform={`translate(${x} 64)`}>
          <path d="M0 0 L-13 -9 L-11 9 Z M0 0 L13 -9 L11 9 Z" fill={INK} />
          <path d="M0 0 L-6 16 M0 0 L6 16" stroke={INK} strokeWidth={4} strokeLinecap="round" />
          <circle r={4} fill={INK} />
        </g>
      ))}

      {mood === 'confused' && (
        <>
          <path d="M150 72 C146 80 145 86 150 89 C155 86 154 80 150 72 Z" fill="#9fd3f5" stroke={INK} strokeWidth={2} />
          <text x={160} y={52} fontSize={30} fontWeight={800} fill={INK} fontFamily="Baloo 2, sans-serif">
            ?
          </text>
        </>
      )}

      {mood === 'cat' && (
        // Outer group positions, inner group animates: a CSS transform on an
        // SVG element replaces its transform attribute, so the two can't share one.
        <g transform="translate(136 168) scale(0.85)">
          <g className="chibi-cat">
            <path d="M-20 24 C-20 0 -14 -12 0 -12 C14 -12 20 0 20 24 Z" fill="#fff" stroke={INK} strokeWidth={2.5} />
            <path d="M-14 -6 L-16 -20 L-6 -11 Z M14 -6 L16 -20 L6 -11 Z" fill="#fff" stroke={INK} strokeWidth={2.5} strokeLinejoin="round" />
            <circle cx={-6} cy={0} r={2} fill={INK} />
            <circle cx={6} cy={0} r={2} fill={INK} />
            <path d="M-3 5 Q0 8 3 5" stroke={INK} strokeWidth={1.8} fill="none" strokeLinecap="round" />
          </g>
        </g>
      )}
    </svg>
  )
}
