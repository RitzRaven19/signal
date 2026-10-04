"""FastAPI app for Signal.

Users are identified by an opaque cookie, not real auth (see PLAN.md's
"explicitly not building" list). /api/watchlist fetches quotes live from
Yahoo on each request -- there's no scheduler populating a quotes table
yet, so staleness reflects Yahoo's own as_of, not a cache.
"""

from __future__ import annotations

import mimetypes
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import date as date_type, datetime, timedelta, timezone
from pathlib import Path
from typing import Literal, Optional

import httpx
from fastapi import Cookie, FastAPI, HTTPException, Request, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from sqlalchemy import text

from . import ai, funds, market, models, news, state_service
from .db import get_engine
from .detector import Event
from .diff import diff_states, is_load_bearing
from .sources import SourceError, fetch_daily_history, fetch_intraday_quote, fetch_stock_chart, nse_is_open

app = FastAPI(title="Signal")

USER_COOKIE = "signal_user_id"
COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365
IST = timezone(timedelta(hours=5, minutes=30))


def get_user_id(response: Response, signal_user_id: Optional[str] = Cookie(default=None)) -> str:
    if signal_user_id:
        return signal_user_id
    new_id = uuid.uuid4().hex
    response.set_cookie(
        USER_COOKIE,
        new_id,
        max_age=COOKIE_MAX_AGE_SECONDS,
        httponly=True,
        samesite="lax",
    )
    return new_id


class WatchlistAdd(BaseModel):
    symbol: str


class AckRequest(BaseModel):
    symbol: str
    seen_until: datetime


@app.get("/api/watchlist")
def get_watchlist(response: Response, signal_user_id: Optional[str] = Cookie(default=None)):
    user_id = get_user_id(response, signal_user_id)
    engine = get_engine()
    with engine.connect() as conn:
        rows = conn.execute(
            text("select symbol, added_at from watchlist where user_id = :user_id order by added_at"),
            {"user_id": user_id},
        ).mappings().all()

    out = []
    with httpx.Client() as client:
        for row in rows:
            symbol = row["symbol"]
            entry = {"symbol": symbol, "added_at": row["added_at"]}
            try:
                quote = fetch_intraday_quote(symbol, client=client)
                pct_change = (
                    (quote.price - quote.prev_close) / quote.prev_close
                    if quote.prev_close
                    else None
                )
                entry.update(
                    price=quote.price,
                    prev_close=quote.prev_close,
                    pct_change=pct_change,
                    volume=quote.volume,
                    as_of=quote.as_of,
                    staleness=quote.staleness.value,
                    source=quote.source,
                )
            except SourceError as exc:
                entry.update(
                    price=None,
                    prev_close=None,
                    pct_change=None,
                    volume=None,
                    as_of=None,
                    staleness="unknown",
                    source="yahoo",
                    error=str(exc),
                )
            out.append(entry)

    return {"user_id": user_id, "watchlist": out}


@app.post("/api/watchlist", status_code=201)
def add_to_watchlist(body: WatchlistAdd, response: Response, signal_user_id: Optional[str] = Cookie(default=None)):
    user_id = get_user_id(response, signal_user_id)
    engine = get_engine()
    with engine.begin() as conn:
        conn.execute(
            text(
                """
                insert into watchlist (user_id, symbol)
                values (:user_id, :symbol)
                on conflict (user_id, symbol) do nothing
                """
            ),
            {"user_id": user_id, "symbol": body.symbol},
        )
    return {"user_id": user_id, "symbol": body.symbol}


@app.delete("/api/watchlist/{symbol}")
def remove_from_watchlist(symbol: str, response: Response, signal_user_id: Optional[str] = Cookie(default=None)):
    user_id = get_user_id(response, signal_user_id)
    engine = get_engine()
    with engine.begin() as conn:
        result = conn.execute(
            text("delete from watchlist where user_id = :user_id and symbol = :symbol"),
            {"user_id": user_id, "symbol": symbol},
        )
    if result.rowcount == 0:
        raise HTTPException(status_code=404, detail=f"{symbol} is not on this watchlist")
    return {"user_id": user_id, "removed": symbol}


FEED_QUERY = text(
    """
    select e.id, e.symbol, e.type, e.score, e.reason, e.evidence, e.occurred_at, e.fingerprint
    from events e
    join watchlist w on w.symbol = e.symbol and w.user_id = :user_id
    left join ack a on a.symbol = e.symbol and a.user_id = :user_id
    where
        case
            when :lens = 'today' then e.occurred_at >= :today_start
            when :lens = 'since_added' then e.occurred_at > w.added_at
            else e.occurred_at > coalesce(a.acked_at, w.added_at)
        end
    order by e.score desc
    """
)


@app.get("/api/feed")
def get_feed(
    response: Response,
    lens: Literal["since_last", "today", "since_added"] = "since_last",
    signal_user_id: Optional[str] = Cookie(default=None),
):
    user_id = get_user_id(response, signal_user_id)
    # "Today" means the NSE trading day in IST, not the server's local
    # calendar date -- those disagree for ~5.5 hours a day whenever the
    # server isn't itself running in IST.
    today_start = datetime.now(IST).replace(hour=0, minute=0, second=0, microsecond=0)

    engine = get_engine()
    with engine.connect() as conn:
        rows = conn.execute(
            FEED_QUERY,
            {"user_id": user_id, "lens": lens, "today_start": today_start},
        ).mappings().all()

    return {"user_id": user_id, "lens": lens, "events": [dict(row) for row in rows]}


@app.post("/api/ack")
def post_ack(body: AckRequest, response: Response, signal_user_id: Optional[str] = Cookie(default=None)):
    """Advance the ack watermark for one symbol. Monotonic: acked_at can
    only move forward (GREATEST(existing, incoming)), never rewind --
    a slow request from a second device can't undo a newer ack."""
    user_id = get_user_id(response, signal_user_id)
    engine = get_engine()
    with engine.begin() as conn:
        row = conn.execute(
            text(
                """
                insert into ack (user_id, symbol, acked_at)
                values (:user_id, :symbol, :seen_until)
                on conflict (user_id, symbol) do update
                set acked_at = greatest(ack.acked_at, excluded.acked_at)
                returning acked_at
                """
            ),
            {"user_id": user_id, "symbol": body.symbol, "seen_until": body.seen_until},
        ).first()

    return {"user_id": user_id, "symbol": body.symbol, "acked_at": row[0]}


WATCHLIST_SINCE_QUERY = text(
    """
    select w.symbol, coalesce(a.acked_at, w.added_at) as since
    from watchlist w
    left join ack a on a.symbol = w.symbol and a.user_id = w.user_id
    where w.user_id = :user_id
    """
)


def _as_ist_date(value: datetime) -> date_type:
    return value.astimezone(IST).date() if value.tzinfo else value.date()


@app.get("/api/changed")
def get_changed(response: Response, signal_user_id: Optional[str] = Cookie(default=None)):
    """what_changed(t0, now) = state(now) - state(t0), per SPEC.md -- the
    load-bearing gate, not the event log /api/feed shows. asserted_empty
    is only ever true when we could actually compute state for at least
    one symbol and found no difference; a symbol with too little price
    history yet is reported in insufficient_history instead of being
    folded into a false "nothing changed"."""
    user_id = get_user_id(response, signal_user_id)
    engine = get_engine()
    today = datetime.now(IST).date()

    with engine.connect() as conn:
        rows = conn.execute(WATCHLIST_SINCE_QUERY, {"user_id": user_id}).mappings().all()

    if not rows:
        return {
            "user_id": user_id,
            "as_of": today.isoformat(),
            "statements": [],
            "asserted_empty": True,
            "message": "nothing to check -- your watchlist is empty.",
            "insufficient_history": [],
        }

    with httpx.Client() as client:
        index_closes = state_service.get_index_closes(client)

    statements_out: list[dict] = []
    insufficient: list[dict] = []
    any_evaluable = False

    for row in rows:
        symbol = row["symbol"]
        since_date = _as_ist_date(row["since"])

        t0 = state_service.compute_symbol_state(engine, symbol, since_date, index_closes)
        now = state_service.compute_symbol_state(engine, symbol, today, index_closes)

        if now.fully_blocked:
            insufficient.append(
                {
                    "symbol": symbol,
                    "days_available": now.days_available,
                    "days_needed": state_service.DEFAULT_WINDOW * 2,
                    "blocked_fields": list(now.blocked_fields),
                }
            )
            continue

        any_evaluable = True
        from_id = models.upsert_state_snapshot(engine, t0.state)
        to_id = models.upsert_state_snapshot(engine, now.state)

        for statement in diff_states(t0.state, now.state):
            models.insert_statement(engine, user_id, statement, from_id, to_id)
            statements_out.append(
                {
                    "symbol": statement.symbol,
                    "field": statement.field,
                    "reason": statement.reason,
                    "evidence": statement.evidence,
                    "since": since_date.isoformat(),
                }
            )

    if not any_evaluable:
        return {
            "user_id": user_id,
            "as_of": today.isoformat(),
            "statements": [],
            "asserted_empty": False,
            "message": f"not enough price history yet to tell -- {len(insufficient)} symbol(s) need more days of data.",
            "insufficient_history": insufficient,
        }

    asserted_empty = len(statements_out) == 0
    message = (
        "nothing changed since you last checked."
        if asserted_empty
        else f"{len(statements_out)} thing(s) changed since you last checked."
    )

    return {
        "user_id": user_id,
        "as_of": today.isoformat(),
        "statements": statements_out,
        "asserted_empty": asserted_empty,
        "message": message,
        "insufficient_history": insufficient,
    }


QUIET_LOG_EVENTS_QUERY = text(
    """
    select e.symbol, e.type, e.score, e.reason, e.evidence, e.occurred_at
    from events e
    join watchlist w on w.symbol = e.symbol and w.user_id = :user_id
    where e.occurred_at >= :since_floor
    order by e.occurred_at desc
    """
)

QUIET_LOG_LOOKBACK_DAYS = 30


@app.get("/api/quiet-log")
def get_quiet_log(response: Response, signal_user_id: Optional[str] = Cookie(default=None)):
    """Events that cleared the residual gate but did NOT survive the
    load-bearing gate -- fired, then reverted before they changed
    anything lasting. This is the SUM(events) view this app deliberately
    keeps out of /api/changed; it lives here, one click behind the net
    view, so nothing is silently dropped."""
    user_id = get_user_id(response, signal_user_id)
    engine = get_engine()
    today = datetime.now(IST).date()
    since_floor = datetime.now(IST) - timedelta(days=QUIET_LOG_LOOKBACK_DAYS)

    with engine.connect() as conn:
        watchlist_rows = conn.execute(WATCHLIST_SINCE_QUERY, {"user_id": user_id}).mappings().all()
        event_rows = conn.execute(QUIET_LOG_EVENTS_QUERY, {"user_id": user_id, "since_floor": since_floor}).mappings().all()

    if not watchlist_rows:
        return {"user_id": user_id, "events": [], "asserted_empty": True, "message": "your watchlist is empty."}

    since_by_symbol = {row["symbol"]: _as_ist_date(row["since"]) for row in watchlist_rows}

    with httpx.Client() as client:
        index_closes = state_service.get_index_closes(client)

    state_cache: dict[tuple, state_service.SymbolState] = {}

    def state_for(symbol: str, as_of: date_type) -> state_service.SymbolState:
        key = (symbol, as_of)
        if key not in state_cache:
            state_cache[key] = state_service.compute_symbol_state(engine, symbol, as_of, index_closes)
        return state_cache[key]

    quiet = []
    for row in event_rows:
        symbol = row["symbol"]
        since_date = since_by_symbol.get(symbol)
        if since_date is None:
            continue  # event is for a symbol no longer on this user's watchlist

        t0 = state_for(symbol, since_date)
        now = state_for(symbol, today)
        if now.fully_blocked:
            continue  # not enough history to say either way -- unknown, not quiet

        event = Event(
            symbol=symbol,
            type=row["type"],
            score=row["score"],
            reason=row["reason"],
            evidence=row["evidence"],
            occurred_at=row["occurred_at"],
            fingerprint="",
        )
        if not is_load_bearing(event, t0.state, now.state):
            quiet.append(
                {
                    "symbol": symbol,
                    "type": row["type"],
                    "reason": row["reason"],
                    "occurred_at": row["occurred_at"],
                    "score": row["score"],
                }
            )

    return {
        "user_id": user_id,
        "as_of": today.isoformat(),
        "events": quiet,
        "asserted_empty": len(quiet) == 0,
        "message": (
            f"no fired-and-forgotten alerts in the last {QUIET_LOG_LOOKBACK_DAYS} days."
            if not quiet
            else f"{len(quiet)} alert(s) fired but didn't change anything lasting."
        ),
    }


INDICES = [
    ("^NSEI", "NIFTY 50"),
    ("^BSESN", "SENSEX"),
    ("^NSEBANK", "BANK NIFTY"),
    ("NIFTY_MIDCAP_100.NS", "MIDCAP 100"),
    ("^CNXSC", "SMALLCAP 100"),
    ("^INDIAVIX", "INDIA VIX"),
]
SECTORS = [
    ("^CNXIT", "IT"),
    ("NIFTY_FIN_SERVICE.NS", "financial services"),
    ("^CNXPSUBANK", "PSU banks"),
    ("^CNXAUTO", "auto"),
    ("^CNXPHARMA", "pharma"),
    ("^CNXFMCG", "FMCG"),
    ("^CNXMETAL", "metal"),
    ("^CNXENERGY", "energy"),
    ("^CNXREALTY", "realty"),
    ("^CNXINFRA", "infra"),
    ("^CNXMEDIA", "media"),
    ("^CNXCONSUM", "consumption"),
]
INDEX_CACHE_SECONDS = 60
# Outside NSE hours prices don't move, and Yahoo can take 15s+ for all 18
# quotes (seen Oct 2026) -- keep them longer so evening visits are fast.
INDEX_CACHE_CLOSED_SECONDS = 900
_index_cache: dict = {"at": None, "data": None}


def _index_quote(client: httpx.Client, symbol: str, label: str) -> dict:
    try:
        q = fetch_intraday_quote(symbol, client=client)
    except SourceError:
        return {"symbol": symbol, "name": label, "price": None, "error": "unavailable"}
    return {
        "symbol": symbol, "name": label, "price": q.price, "prev_close": q.prev_close,
        "pct_change": (q.price - q.prev_close) / q.prev_close if q.prev_close else None,
        "as_of": q.as_of, "staleness": q.staleness.value,
    }


def _index_quotes() -> tuple[list, list]:
    """Headline indices and sector indices, fetched in parallel and cached
    for a minute -- 18 Yahoo calls one after another took ~10s, and every
    visitor re-fetching them would just get us rate-limited."""
    now = datetime.now(timezone.utc)
    ttl = INDEX_CACHE_SECONDS if nse_is_open(now) else INDEX_CACHE_CLOSED_SECONDS
    if _index_cache["at"] and now - _index_cache["at"] < timedelta(seconds=ttl):
        return _index_cache["data"]
    wanted = INDICES + SECTORS
    with httpx.Client(timeout=15) as client, ThreadPoolExecutor(max_workers=8) as pool:
        quotes = list(pool.map(lambda pair: _index_quote(client, *pair), wanted))
    data = (quotes[: len(INDICES)], quotes[len(INDICES):])
    _index_cache.update(at=now, data=data)
    return data


@app.get("/api/market")
def get_market():
    """Market overview: indices and sectors (live from Yahoo), breadth and
    today's movers across every listed NSE company (from the bhavcopy)."""
    engine = get_engine()
    indices, sectors = _index_quotes()
    return {
        "as_of_date": market.latest_date(engine),
        "indices": indices,
        "sectors": sectors,
        "breadth": market.breadth(engine),
        "movers": {s: market.run_scan(engine, s, limit=5) for s in ("gainers", "losers", "most_active")},
        "scans": market.SCANS,
    }


@app.get("/api/scans/{scan}")
def get_scan(scan: str, limit: int = 25):
    if scan not in market.SCANS:
        raise HTTPException(status_code=404, detail=f"unknown scan '{scan}'")
    engine = get_engine()
    return {
        "scan": scan,
        "title": market.SCANS[scan],
        "as_of_date": market.latest_date(engine),
        "results": market.run_scan(engine, scan, limit=min(max(limit, 1), 50)),
    }


MAX_QUOTES = 30


@app.get("/api/quotes")
def get_quotes(symbols: str = ""):
    """Latest quotes for a comma-separated list of symbols (the practice
    portfolio's holdings), fetched in parallel."""
    wanted = list(dict.fromkeys(s.strip().upper() for s in symbols.split(",") if s.strip()))[:MAX_QUOTES]
    if not wanted:
        return {"quotes": {}}
    with httpx.Client(timeout=15) as client, ThreadPoolExecutor(max_workers=8) as pool:
        quotes = list(pool.map(lambda s: _index_quote(client, s, s), wanted))
    return {"quotes": {q["symbol"]: q for q in quotes}}


@app.get("/api/boutique")
def get_boutique(symbols: str = ""):
    wanted = list(dict.fromkeys(s.strip().upper() for s in symbols.split(",") if s.strip()))[:60]
    return {"as_of_date": market.latest_date(get_engine()), "items": market.boutique(get_engine(), wanted) if wanted else {}}


class AIExplainRequest(BaseModel):
    title: str
    about: str = ""
    context: str = ""
    question: str = ""
    history: list[dict] = []


@app.post("/api/ai/explain")
def ai_explain(body: AIExplainRequest, request: Request, signal_user_id: Optional[str] = Cookie(default=None)):
    """Beginner explanation of whatever the user points at (Gemini free tier).
    Errors come back as 200 with ok=false and a friendly message, so the
    page can fall back to its built-in explanation."""
    visitor = signal_user_id or (request.client.host if request.client else "anon")
    try:
        text = ai.explain(
            visitor=visitor, title=body.title[:120], about=body.about[:400],
            context=body.context, history=body.history, question=body.question,
        )
    except ai.AIUnavailable as exc:
        return {"ok": False, "text": str(exc)}
    return {"ok": True, "text": text}


@app.get("/api/unusual")
def get_unusual():
    """Today's moves the market doesn't explain, among the most-traded stocks."""
    try:
        return news.unusual_moves(get_engine())
    except SourceError:
        # NIFTY history unavailable (Yahoo refused): say so, don't claim "nothing unusual"
        return {"as_of_date": None, "moves": [], "checked": 0, "unavailable": True}


@app.get("/api/stock/{symbol}/news")
def get_stock_news(symbol: str):
    symbol = symbol.upper()
    name = market.instrument_name(get_engine(), symbol)
    return {"symbol": symbol, "news": news.company_news(symbol, name), "announcements": news.announcements(symbol)}


@app.post("/api/stock/{symbol}/why")
def why_it_moved(symbol: str, request: Request, signal_user_id: Optional[str] = Cookie(default=None)):
    """AI summary of what today's headlines and NSE announcements mention
    that could relate to the move. Explains; never predicts."""
    symbol = symbol.upper()
    name = market.instrument_name(get_engine(), symbol)
    move = news.day_move(get_engine(), symbol)
    pct = move["pct"] if move else None
    npct = move["index_pct"] if move else None
    heads = news.company_news(symbol, name)
    anns = news.announcements(symbol)
    if not heads and not anns:
        return {"ok": False, "text": "i couldn't find any recent headlines or announcements for this company, so i can't say what's behind the move."}
    day = f" on {move['date']}" if move else ""
    lines = [f"{symbol} ({name}): {pct:+.2%}{day}" + (f"; NIFTY 50: {npct:+.2%} the same day." if npct is not None else ".") if pct is not None else f"{symbol} ({name})"]
    lines += [f"NSE announcement {a['at']}: {a['subject']} - {a['text']}" for a in anns[:4]]
    lines += [f"headline ({h['source']}, {(h['published'] or '')[:10]}): {h['title']}" for h in heads[:8]]
    question = (
        "using ONLY the price moves, announcements and headlines above, explain in plain words what they mention "
        "that could relate to today's move, and whether the move looks company-specific or market-wide. say "
        "'headlines mention…', never claim certainty, never predict what happens next, never advise. if nothing "
        "seems related, say no clear reason shows up in the news. under 90 words."
    )
    visitor = signal_user_id or (request.client.host if request.client else "anon")
    try:
        text_ = ai.explain(visitor=visitor, title=f"why {symbol.replace('.NS', '')} moved today",
                           about="what recent news and announcements mention", context="\n".join(lines),
                           history=[], question=question)
    except ai.AIUnavailable as exc:
        return {"ok": False, "text": str(exc)}
    return {"ok": True, "text": text_, "pct": pct, "index_pct": npct}


@app.get("/api/search")
def search(q: str = ""):
    return {"q": q, "results": market.search_symbols(get_engine(), q)}


@app.get("/api/funds/search")
def search_funds(q: str = ""):
    try:
        return {"q": q, "results": funds.search_funds(q)}
    except funds.FundError as exc:
        raise HTTPException(status_code=502, detail=str(exc))


@app.get("/api/funds/{code}")
def get_fund(code: int):
    try:
        return funds.get_fund(code)
    except funds.FundError as exc:
        raise HTTPException(status_code=404, detail=str(exc))


@app.get("/api/stock/{symbol}")
def get_stock(symbol: str):
    """Stock page: identity, day and 52-week stats and a year of daily bars
    from Yahoo, plus delivery %, trade count, average volume and recent
    alerts from our own NSE data."""
    symbol = symbol.upper()
    engine = get_engine()
    try:
        chart = fetch_stock_chart(symbol, range_="2y")  # 2y so the 200-day average spans the whole 1y chart
    except SourceError as exc:
        raise HTTPException(status_code=404, detail=f"no market data for {symbol}: {exc}")
    return {
        "symbol": symbol,
        "name": market.instrument_name(engine, symbol) or chart.name,
        "exchange": chart.exchange,
        "price": chart.price,
        "prev_close": chart.prev_close,
        "pct_change": (chart.price - chart.prev_close) / chart.prev_close if chart.price and chart.prev_close else None,
        "day_high": chart.day_high,
        "day_low": chart.day_low,
        "volume": chart.volume,
        "week52_high": chart.week52_high,
        "week52_low": chart.week52_low,
        "as_of": chart.as_of,
        "staleness": chart.staleness.value,
        "bars": chart.bars,
        **market.stock_stats(engine, symbol),
    }


@app.get("/api/health/sources")
def health_sources():
    """Cheap reachability probe for the upstreams this app depends on --
    proof the source answers, not a full quote. No DB, no persistence."""
    checks: dict[str, dict] = {}
    with httpx.Client() as client:
        for name, probe in (
            ("yahoo_quote", lambda: fetch_intraday_quote("RELIANCE.NS", client=client)),
            ("yahoo_index", lambda: fetch_daily_history(state_service.INDEX_SYMBOL, range_="5d", client=client)),
        ):
            start = datetime.now(timezone.utc)
            try:
                probe()
                latency_ms = (datetime.now(timezone.utc) - start).total_seconds() * 1000
                checks[name] = {"ok": True, "latency_ms": round(latency_ms, 1)}
            except SourceError as exc:
                checks[name] = {"ok": False, "error": str(exc)}
    return {"as_of": datetime.now(timezone.utc).isoformat(), "sources": checks}


# Serves the built React app (frontend/dist) at "/" when present -- one
# deploy, no CORS. Mounted last so it never shadows the /api/* routes above.
# Missing during backend-only dev; harmless, just nothing at "/" until built.
FRONTEND_DIST = Path(__file__).resolve().parent.parent.parent / "frontend" / "dist"
if FRONTEND_DIST.is_dir():
    # Browsers want the app manifest served as such for "install app".
    mimetypes.add_type("application/manifest+json", ".webmanifest")
    app.mount("/", StaticFiles(directory=str(FRONTEND_DIST), html=True), name="frontend")
