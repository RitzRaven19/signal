"""FastAPI app for Signal.

Users are identified by an opaque cookie, not real auth (see PLAN.md's
"explicitly not building" list). /api/watchlist fetches quotes live from
Yahoo on each request -- there's no scheduler populating a quotes table
yet, so staleness reflects Yahoo's own as_of, not a cache.
"""

from __future__ import annotations

import uuid
from datetime import date as date_type, datetime, timedelta, timezone
from pathlib import Path
from typing import Literal, Optional

import httpx
from fastapi import Cookie, FastAPI, HTTPException, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from sqlalchemy import text

from . import models, state_service
from .db import get_engine
from .detector import Event
from .diff import diff_states, is_load_bearing
from .sources import SourceError, fetch_daily_history, fetch_intraday_quote

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
    app.mount("/", StaticFiles(directory=str(FRONTEND_DIST), html=True), name="frontend")
