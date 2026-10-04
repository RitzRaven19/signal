// Placeholder shapes shown while data loads, in the same layout as the real
// content, so the page doesn't jump and feels faster than a blank wait.
const Line = ({ w = '60%', h = 12 }) => <span className="sk-line" style={{ width: w, height: h }} />

export function SkeletonTiles({ count = 4 }) {
  return (
    <div className="snap-row" aria-hidden="true">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="snap-tile sk-box">
          <Line w="45%" h={10} />
          <Line w="70%" h={20} />
          <Line w="35%" h={14} />
        </div>
      ))}
    </div>
  )
}

export function SkeletonRows({ count = 5 }) {
  return (
    <ul className="mkt-list" aria-hidden="true">
      {Array.from({ length: count }, (_, i) => (
        <li key={i} className="mkt-row sk-box">
          <div className="mkt-id">
            <Line w="30%" h={14} />
            <Line w="60%" h={10} />
          </div>
          <div className="mkt-quote">
            <Line w="70px" h={14} />
            <Line w="50px" h={12} />
          </div>
        </li>
      ))}
    </ul>
  )
}

export function SkeletonCards({ count = 6 }) {
  return (
    <div className="product-grid" aria-hidden="true">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="product-card sk-box">
          <span className="product-logo sk-circle" />
          <Line w="65%" h={16} />
          <Line w="85%" h={10} />
          <Line w="50%" h={20} />
          <Line w="100%" h={32} />
        </div>
      ))}
    </div>
  )
}

// A full-tab placeholder for the market view: index tiles, a wide card, rows.
export function SkeletonMarket() {
  return (
    <div className="mkt" role="status" aria-label="loading the market">
      <SkeletonTiles count={5} />
      <section className="pane sk-box">
        <Line w="30%" h={22} />
        <SkeletonTiles count={5} />
      </section>
      <section className="pane">
        <Line w="25%" h={22} />
        <SkeletonRows count={5} />
      </section>
    </div>
  )
}
