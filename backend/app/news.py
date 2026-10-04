"""Incidents behind a move: company headlines, NSE announcements, and the
day's unusual moves.

- Headlines: Google News RSS search for the company (free, no key).
- Announcements: NSE corporate announcements (free; NSE sometimes blocks
  cloud servers, so this quietly returns [] when it can't get through).
- Unusual moves: today's residual moves among the most-traded stocks --
  the same beta/residual maths as the alerts, run on the latest session.

This explains what happened; it never predicts what happens next.
"""

from __future__ import annotations

import re
import time
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta
from email.utils import parsedate_to_datetime
from urllib.parse import quote_plus

import httpx
import numpy as np
from sqlalchemy import text
from sqlalchemy.engine import Engine

from .detector import fit_beta, residual_z
from .sources import IST, USER_AGENT, SourceError, fetch_daily_history

NEWS_CACHE_SECONDS = 1800
NEWS_LIMIT = 8
UNUSUAL_UNIVERSE = 150
UNUSUAL_Z = 2.5
BETA_SESSIONS = 60

_news_cache: dict[str, tuple[float, list]] = {}
_ann_cache: dict[str, tuple[float, list]] = {}
_unusual_cache: dict = {"key": None, "data": None}
_nifty_cache: dict = {"at": 0.0, "data": None}

# "Tata Consultancy Services Limited" -> "Tata Consultancy Services"
_SUFFIX = re.compile(r"\s+(limited|ltd\.?|india limited|\(india\) limited)$", re.I)


def short_name(name: str | None, symbol: str) -> str:
    name = (name or "").strip()
    while True:
        cut = _SUFFIX.sub("", name)
        if cut == name:
            break
        name = cut
    return name or symbol.replace(".NS", "")


def company_news(symbol: str, name: str | None) -> list[dict]:
    hit = _news_cache.get(symbol)
    if hit and time.time() - hit[0] < NEWS_CACHE_SECONDS:
        return hit[1]
    query = f'"{short_name(name, symbol)}" (share OR stock OR shares) when:7d'
    url = f"https://news.google.com/rss/search?q={quote_plus(query)}&hl=en-IN&gl=IN&ceid=IN:en"
    items: list[dict] = []
    try:
        r = httpx.get(url, headers={"User-Agent": USER_AGENT}, timeout=15, follow_redirects=True)
        r.raise_for_status()
        root = ET.fromstring(r.content)
        for it in root.iter("item"):
            title = (it.findtext("title") or "").strip()
            source = (it.findtext("source") or "").strip()
            if source and title.endswith(f" - {source}"):
                title = title[: -len(source) - 3]
            try:
                published = parsedate_to_datetime(it.findtext("pubDate")).isoformat()
            except (TypeError, ValueError):
                published = None
            items.append({"title": title, "source": source, "link": it.findtext("link"), "published": published})
            if len(items) >= NEWS_LIMIT:
                break
    except (httpx.HTTPError, ET.ParseError):
        items = []
    _news_cache[symbol] = (time.time(), items)
    return items


def announcements(symbol: str, days: int = 14) -> list[dict]:
    hit = _ann_cache.get(symbol)
    if hit and time.time() - hit[0] < NEWS_CACHE_SECONDS:
        return hit[1]
    out: list[dict] = []
    try:
        from nse import NSE  # local import: optional at runtime

        from .bhavcopy import DATA_DIR

        DATA_DIR.mkdir(parents=True, exist_ok=True)
        to = datetime.now(IST).replace(tzinfo=None)
        with NSE(download_folder=str(DATA_DIR)) as nse:
            rows = nse.announcements(symbol=symbol.replace(".NS", ""), from_date=to - timedelta(days=days), to_date=to)
        for a in rows[:6]:
            out.append({
                "subject": a.get("desc"),
                "text": (a.get("attchmntText") or "").strip()[:300],
                "at": a.get("sort_date"),
                "pdf": a.get("attchmntFile"),
            })
    except Exception:  # noqa: BLE001 -- NSE blocks some servers; headlines still work
        out = []
    _ann_cache[symbol] = (time.time(), out)
    return out


def _nifty_closes() -> dict:
    """NIFTY daily closes, cached an hour. If Yahoo refuses (it rate-limits
    and resets connections at times), keep using the last good copy."""
    if _nifty_cache["data"] and time.time() - _nifty_cache["at"] < 3600:
        return _nifty_cache["data"]
    try:
        data = {b.d.astimezone(IST).date(): b.close for b in fetch_daily_history("^NSEI", range_="6mo")}
    except SourceError:
        if _nifty_cache["data"]:
            return _nifty_cache["data"]
        raise
    _nifty_cache.update(at=time.time(), data=data)
    return data


def day_move(engine: Engine, symbol: str) -> dict | None:
    """The latest session's move for a stock (from our NSE data) and NIFTY's
    move that same day -- the session the unusual-moves list is built on."""
    with engine.connect() as conn:
        rows = conn.execute(text("select d, close from daily_bars where symbol = :s order by d desc limit 2"), {"s": symbol}).all()
    if len(rows) < 2:
        return None
    (d1, c1), (d0, c0) = rows
    out = {"date": d1.isoformat(), "pct": float(c1) / float(c0) - 1, "index_pct": None}
    try:
        nifty = _nifty_closes()
        if d1 in nifty and d0 in nifty:
            out["index_pct"] = nifty[d1] / nifty[d0] - 1
    except SourceError:
        pass
    return out


_UNUSUAL_SQL = text("""
    with t as (select max(d) d from daily_bars),
    top as (
        select b.symbol from daily_bars b join instruments i on i.symbol = b.symbol and i.kind = 'equity'
        where b.d > (select d from t) - 30
        group by b.symbol having count(*) >= 15
        order by percentile_cont(0.5) within group (order by b.close * b.volume) desc limit :n
    )
    select b.symbol, i.name, b.d, b.close from daily_bars b
    join top using (symbol) join instruments i on i.symbol = b.symbol
    where b.d > (select d from t) - 120
    order by b.symbol, b.d
""")


def unusual_moves(engine: Engine, limit: int = 8) -> dict:
    """The latest session's moves that the market doesn't explain (|z| >= 2.5)
    among the most-traded stocks: beta and residual sigma from the sessions
    before it, like the alerts."""
    with engine.connect() as conn:
        latest = conn.execute(text("select max(d) from daily_bars")).scalar()
    if _unusual_cache["key"] == latest and _unusual_cache["data"] is not None:
        return _unusual_cache["data"]
    nifty = _nifty_closes()
    with engine.connect() as conn:
        rows = conn.execute(_UNUSUAL_SQL, {"n": UNUSUAL_UNIVERSE}).all()
    series: dict[str, list] = {}
    names: dict[str, str] = {}
    for sym, name, d, close in rows:
        if d in nifty:
            series.setdefault(sym, []).append((d, float(close)))
            names[sym] = name
    moves = []
    for sym, pts in series.items():
        if len(pts) < 30 or pts[-1][0] != latest:
            continue
        pts = pts[-(BETA_SESSIONS + 2):]
        closes = [c for _, c in pts]
        idx = [nifty[d] for d, _ in pts]
        try:
            fit = fit_beta(sym, closes[:-1], idx[:-1])
        except ValueError:
            continue
        stock_ret = float(np.log(closes[-1] / closes[-2]))
        index_ret = float(np.log(idx[-1] / idx[-2]))
        z = residual_z(stock_ret, index_ret, fit.beta, fit.resid_sigma)
        if abs(z) >= UNUSUAL_Z:
            moves.append({
                "symbol": sym, "name": names[sym], "pct": float(np.expm1(stock_ret)),
                "index_pct": float(np.expm1(index_ret)), "explained_pct": float(fit.beta * index_ret),
                "z": float(z),
            })
    moves.sort(key=lambda m: abs(m["z"]), reverse=True)
    data = {"as_of_date": latest.isoformat() if latest else None, "moves": moves[:limit], "checked": len(series)}
    _unusual_cache.update(key=latest, data=data)
    return data
