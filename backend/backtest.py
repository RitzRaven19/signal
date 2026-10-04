"""Accuracy report: does the residual detector beat a naive ±2% alert?

Replays both detectors over the NSE bhavcopy history in daily_bars
(read-only) for the most-traded stocks, and scores every alert against a
label neither detector looks at:

    follow-through = next-day volume >= 1.5x the stock's median volume
                     over the 20 sessions before the alert

Both detectors fire on *price*; the label is *next-day volume*, so it
doesn't hand either one the answer. It is a proxy for "something real
happened to this company", not ground truth -- see the README caveats.

    python backtest.py            # prints the markdown table
"""

from __future__ import annotations

import statistics
from collections import defaultdict
from datetime import datetime

import numpy as np
from sqlalchemy import text

from app.db import get_engine
from app.detector import Z_THRESHOLD, detect_residual_move, fit_beta
from app.sources import IST, fetch_daily_history

UNIVERSE = 100           # most-traded stocks by median daily value
BETA_LOOKBACK = 60       # sessions used to fit beta (fewer if not yet available)
MIN_HISTORY = 30         # sessions needed before a stock can alert
NAIVE_MOVE = 0.02        # the naive rule: |daily return| >= 2%
FOLLOW_VOLUME = 1.5      # label: next-day volume >= 1.5x trailing median
VOLUME_WINDOW = 20
WATCHLIST = 20           # "alerts per user per day" assumes a 20-stock watchlist
BIG_INDEX_DAY = 0.01     # |NIFTY| >= 1% counts as a market-wide day


def load():
    engine = get_engine()
    with engine.connect() as conn:
        top = [r[0] for r in conn.execute(text("""
            select b.symbol from daily_bars b join instruments i on i.symbol = b.symbol and i.kind = 'equity'
            group by b.symbol having count(*) >= :min
            order by percentile_cont(0.5) within group (order by b.close * b.volume) desc limit :n
        """), {"min": MIN_HISTORY + 10, "n": UNIVERSE})]
        rows = conn.execute(text("select symbol, d, close, volume from daily_bars where symbol = any(:s) order by d"), {"s": top}).all()
    bars = defaultdict(dict)
    for sym, d, close, volume in rows:
        bars[sym][d] = (float(close), int(volume))
    nifty = {b.d.astimezone(IST).date(): b.close for b in fetch_daily_history("^NSEI", range_="1y")}
    return bars, nifty


def run(bars, nifty):
    dates = sorted({d for s in bars.values() for d in s} & set(nifty))
    stats = {k: {"alerts": 0, "hits": 0, "big_day_alerts": 0} for k in ("naive", "residual")}
    base = {"days": 0, "hits": 0}
    stock_days = 0
    moves = []  # (|return|, hit, big_day) for every stock-day, for the matched naive rule
    for sym, series in bars.items():
        ds = [d for d in dates if d in series]
        for t in range(MIN_HISTORY, len(ds) - 1):
            d, nxt = ds[t], ds[t + 1]
            if (nxt - d).days > 5:
                continue  # a gap in the data, not a next trading day
            closes = [series[x][0] for x in ds[max(0, t - BETA_LOOKBACK): t + 1]]
            idx = [nifty[x] for x in ds[max(0, t - BETA_LOOKBACK): t + 1]]
            stock_ret = float(np.log(closes[-1] / closes[-2]))
            index_ret = float(np.log(idx[-1] / idx[-2]))
            prior_vol = [series[x][1] for x in ds[max(0, t - VOLUME_WINDOW): t]]
            hit = series[nxt][1] >= FOLLOW_VOLUME * statistics.median(prior_vol)
            big_day = abs(index_ret) >= BIG_INDEX_DAY

            stock_days += 1
            moves.append((abs(stock_ret), hit, big_day))
            base["days"] += 1
            base["hits"] += hit

            # Out of sample: beta and residual sigma from the sessions BEFORE today.
            fit = fit_beta(sym, closes[:-1], idx[:-1])
            fired = {
                "naive": abs(stock_ret) >= NAIVE_MOVE,
                "residual": detect_residual_move(fit, stock_ret, index_ret, occurred_at=datetime(d.year, d.month, d.day, tzinfo=IST), z_threshold=Z_THRESHOLD) is not None,
            }
            for k, f in fired.items():
                if f:
                    stats[k]["alerts"] += 1
                    stats[k]["hits"] += hit
                    stats[k]["big_day_alerts"] += big_day
    # Fairness check: a naive rule tuned to fire exactly as often as the
    # residual detector (the N biggest raw moves). If residual still wins,
    # it isn't just "picking bigger moves".
    n = stats["residual"]["alerts"]
    top = sorted(moves, key=lambda m: m[0], reverse=True)[:n]
    stats["matched"] = {"alerts": n, "hits": sum(m[1] for m in top), "big_day_alerts": sum(m[2] for m in top),
                        "threshold": top[-1][0] if top else None}
    big_days = sum(1 for a, b in zip(dates, dates[1:]) if abs(np.log(nifty[b] / nifty[a])) >= BIG_INDEX_DAY)
    return stats, base, stock_days, dates, big_days


def report(stats, base, stock_days, dates, big_days):
    base_rate = base["hits"] / base["days"]
    lines = [
        f"Replay: {dates[0]} to {dates[-1]}, {UNIVERSE} most-traded NSE stocks, {stock_days:,} stock-days "
        f"({big_days} market-wide days with |NIFTY| >= {BIG_INDEX_DAY:.0%}).",
        f"Base rate (any stock-day followed by a next-day volume jump): {base_rate:.1%}.",
        "",
        "| Detector | Alerts fired | Precision (next-day volume follow-through) | Lift vs base rate | Alerts / user / day (20 stocks) | Share fired on market-wide days |",
        "|---|---|---|---|---|---|",
    ]
    thr = stats["matched"]["threshold"]
    names = {
        "naive": "Naive (±2% price)",
        "matched": f"Naive, same alert count (±{thr:.1%})",
        "residual": "Residual (this build)",
    }
    for k in ("naive", "matched", "residual"):
        s = stats[k]
        prec = s["hits"] / s["alerts"] if s["alerts"] else 0
        per_user = s["alerts"] / stock_days * WATCHLIST
        lines.append(
            f"| {names[k]} | {s['alerts']:,} | {prec:.1%} | {prec / base_rate:.2f}x | {per_user:.2f} | "
            f"{s['big_day_alerts'] / s['alerts']:.0%} |"
        )
    return "\n".join(lines)


if __name__ == "__main__":
    bars, nifty = load()
    print(report(*run(bars, nifty)))
