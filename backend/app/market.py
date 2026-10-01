"""Market-wide views over daily_bars: movers, readymade scans, search.

Everything here runs on the NSE bhavcopy rows ingested daily, across all
~2,600 listed equities -- no paid data. "Today" means the latest trading
date in daily_bars (the last published bhavcopy), compared against the
trading date before it.

A liquidity floor (price >= Rs 20 and >= Rs 1 crore traded) keeps penny
and barely-traded stocks out of the lists: without it, gainers/losers
are dominated by names where one tiny trade moves the price 10%.
"""

from __future__ import annotations

from sqlalchemy import text
from sqlalchemy.engine import Engine

MIN_PRICE = 20.0
MIN_TRADED_VALUE = 1e7  # Rs 1 crore

_TODAY_VS_PREV = """
    with days as (
        select distinct d from daily_bars order by d desc limit 2
    ),
    t as (select max(d) d from days),
    p as (select min(d) d from days),
    today as (
        -- companies only: NSE's equity bhavcopy also carries ETFs
        select b.symbol, i.name, b.close, b.volume, b.deliv_pct, b.total_trades,
               b.close * b.volume as traded_value
        from daily_bars b
        join t on b.d = t.d
        join instruments i on i.symbol = b.symbol and i.kind = 'equity'
    ),
    prev as (
        select b.symbol, b.close from daily_bars b, p where b.d = p.d
    )
"""

_SCAN_SQL = {
    "gainers": _TODAY_VS_PREV + """
        select today.*, today.close / prev.close - 1 as pct
        from today join prev using (symbol)
        where today.close >= :min_price and today.traded_value >= :min_value
        order by pct desc limit :limit
    """,
    "losers": _TODAY_VS_PREV + """
        select today.*, today.close / prev.close - 1 as pct
        from today join prev using (symbol)
        where today.close >= :min_price and today.traded_value >= :min_value
        order by pct asc limit :limit
    """,
    "most_active": _TODAY_VS_PREV + """
        select today.*, today.close / prev.close - 1 as pct
        from today join prev using (symbol)
        where today.close >= :min_price
        order by today.traded_value desc limit :limit
    """,
    # Volume vs the symbol's own trailing 20-day median, like the detectors.
    "volume_shockers": _TODAY_VS_PREV + """,
    hist as (
        select b.symbol, percentile_cont(0.5) within group (order by b.volume) as med_vol
        from (
            select symbol, volume, row_number() over (partition by symbol order by d desc) rn
            from daily_bars where d < (select d from t)
        ) b where b.rn <= 20 group by b.symbol
    )
        select today.*, today.close / prev.close - 1 as pct, today.volume / nullif(hist.med_vol, 0) as vol_ratio
        from today join prev using (symbol) join hist using (symbol)
        where today.close >= :min_price and today.traded_value >= :min_value
          and today.volume >= 3 * hist.med_vol
        order by vol_ratio desc limit :limit
    """,
    # Most of the day's volume taken as delivery: buyers holding, not day-trading.
    "high_delivery": _TODAY_VS_PREV + """
        select today.*, today.close / prev.close - 1 as pct
        from today join prev using (symbol)
        where today.close >= :min_price and today.traded_value >= 5 * :min_value
          and today.deliv_pct >= 60
        order by today.deliv_pct desc limit :limit
    """,
    # Within 2% of the highest close in the history we hold (~3-4 months).
    "near_high": _TODAY_VS_PREV + """,
    hi as (select symbol, max(close) as high_close, count(*) as days from daily_bars group by symbol)
        select today.*, today.close / prev.close - 1 as pct, hi.high_close, hi.days as history_days
        from today join prev using (symbol) join hi using (symbol)
        where today.close >= :min_price and today.traded_value >= :min_value
          and hi.days >= 40 and today.close >= 0.98 * hi.high_close
        order by today.traded_value desc limit :limit
    """,
    "block_trades": _TODAY_VS_PREV + """
        select today.*, today.close / prev.close - 1 as pct, e.score as size_ratio, e.reason
        from events e
        join today on today.symbol = e.symbol
        join prev on prev.symbol = e.symbol
        where e.type = 'BLOCK_TRADE' and date(e.occurred_at) = (select d from t)
        order by e.score desc limit :limit
    """,
}

SCANS = {
    "gainers": "top gainers",
    "losers": "top losers",
    "most_active": "most active (by value traded)",
    "volume_shockers": "volume shockers (3x+ their usual volume)",
    "high_delivery": "high delivery (60%+ held, not day-traded)",
    "near_high": "near their recent high",
    "block_trades": "block trades (big-lot buying or selling)",
}


def latest_date(engine: Engine):
    with engine.connect() as conn:
        return conn.execute(text("select max(d) from daily_bars")).scalar()


def run_scan(engine: Engine, scan: str, limit: int = 10) -> list[dict]:
    sql = _SCAN_SQL[scan]
    params = {"min_price": MIN_PRICE, "min_value": MIN_TRADED_VALUE, "limit": limit}
    with engine.connect() as conn:
        rows = conn.execute(text(sql), params).mappings().all()
    out = []
    for r in rows:
        row = {k: (float(v) if hasattr(v, "__float__") and not isinstance(v, (int, bool)) else v) for k, v in dict(r).items()}
        out.append(row)
    return out


_SEARCH_SQL = text(
    """
    with t as (select max(d) d from daily_bars)
    select i.symbol, i.name, i.kind, b.close
    from instruments i
    left join daily_bars b on b.symbol = i.symbol and b.d = (select d from t)
    where i.symbol ilike :pattern or i.name ilike :pattern
    order by (i.symbol ilike :prefix) desc, (i.name ilike :prefix) desc,
             coalesce(b.close * b.volume, 0) desc
    limit :limit
    """
)


def search_symbols(engine: Engine, q: str, limit: int = 8) -> list[dict]:
    """Matches ticker or company name. Ticker prefix first, then name
    prefix, each ranked by value traded -- 'reli' puts RELIANCE first and
    'infosys' finds INFY."""
    q = q.strip().replace("%", "").replace("_", "")
    if not q:
        return []
    with engine.connect() as conn:
        rows = conn.execute(
            _SEARCH_SQL, {"pattern": f"%{q}%", "prefix": f"{q}%", "limit": limit}
        ).mappings().all()
    return [
        {"symbol": r["symbol"], "name": r["name"], "kind": r["kind"], "close": float(r["close"]) if r["close"] is not None else None}
        for r in rows
    ]


def instrument_name(engine: Engine, symbol: str):
    with engine.connect() as conn:
        return conn.execute(text("select name from instruments where symbol = :s"), {"s": symbol}).scalar()


_STOCK_STATS_SQL = text(
    """
    select d, close, volume, deliv_pct, total_trades
    from daily_bars where symbol = :symbol order by d desc limit 20
    """
)

_STOCK_EVENTS_SQL = text(
    """
    select type, score, reason, occurred_at from events
    where symbol = :symbol and occurred_at >= now() - interval '45 days'
    order by occurred_at desc limit 10
    """
)


def stock_stats(engine: Engine, symbol: str) -> dict:
    """What our own NSE data adds on top of the Yahoo quote: delivery %,
    trade count, 20-day average volume, and recent alerts."""
    with engine.connect() as conn:
        bars = conn.execute(_STOCK_STATS_SQL, {"symbol": symbol}).mappings().all()
        events = conn.execute(_STOCK_EVENTS_SQL, {"symbol": symbol}).mappings().all()
    if not bars:
        return {"nse_data": False, "events": []}
    latest = bars[0]
    return {
        "nse_data": True,
        "as_of_date": latest["d"].isoformat(),
        "deliv_pct": float(latest["deliv_pct"]) if latest["deliv_pct"] is not None else None,
        "total_trades": latest["total_trades"],
        "avg_volume_20d": sum(b["volume"] for b in bars) / len(bars),
        "events": [
            {"type": e["type"], "score": float(e["score"]), "reason": e["reason"], "occurred_at": e["occurred_at"].isoformat()}
            for e in events
        ],
    }
