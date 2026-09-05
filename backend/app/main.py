"""FastAPI app for Signal.

Users are identified by an opaque cookie, not real auth (see PLAN.md's
"explicitly not building" list). /api/watchlist fetches quotes live from
Yahoo on each request -- there's no scheduler populating a quotes table
yet, so staleness reflects Yahoo's own as_of, not a cache.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Literal, Optional

import httpx
from fastapi import Cookie, FastAPI, HTTPException, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from sqlalchemy import text

from .db import get_engine
from .sources import SourceError, fetch_intraday_quote

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


# Serves the built React app (frontend/dist) at "/" when present -- one
# deploy, no CORS. Mounted last so it never shadows the /api/* routes above.
# Missing during backend-only dev; harmless, just nothing at "/" until built.
FRONTEND_DIST = Path(__file__).resolve().parent.parent.parent / "frontend" / "dist"
if FRONTEND_DIST.is_dir():
    app.mount("/", StaticFiles(directory=str(FRONTEND_DIST), html=True), name="frontend")
