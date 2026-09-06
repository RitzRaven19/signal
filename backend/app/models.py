"""Events table access for Signal.

Plain SQL, no ORM -- the schema lives in Supabase (applied via migration),
not here. This module just reads/writes rows, deduping on `fingerprint`
so a detector re-scoring the same tick never produces a second event.
"""

from __future__ import annotations

import json
import time
from datetime import date as date_type
from typing import Optional

import pandas as pd
from sqlalchemy import text
from sqlalchemy.engine import Engine
from sqlalchemy.exc import OperationalError

from .detector import Event
from .diff import StateVector, Statement

INSERT_EVENT_SQL = text(
    """
    insert into events (symbol, type, score, reason, evidence, occurred_at, fingerprint)
    values (:symbol, :type, :score, :reason, CAST(:evidence AS jsonb), :occurred_at, :fingerprint)
    on conflict (fingerprint) do nothing
    returning id
    """
)


def insert_event(engine: Engine, event: Event) -> Optional[int]:
    """Insert an event, deduped on fingerprint.

    Returns the new row's id, or None if an event with this fingerprint
    was already logged (the caller should treat that as "already emitted",
    not an error).
    """
    with engine.begin() as conn:
        result = conn.execute(
            INSERT_EVENT_SQL,
            {
                "symbol": event.symbol,
                "type": event.type,
                "score": event.score,
                "reason": event.reason,
                "evidence": json.dumps(event.evidence),
                "occurred_at": event.occurred_at,
                "fingerprint": event.fingerprint,
            },
        )
        row = result.first()
        return row[0] if row else None


INSERT_DAILY_BAR_SQL = text(
    """
    insert into daily_bars (symbol, d, close, volume, deliv_pct, total_trades)
    values (:symbol, :d, :close, :volume, :deliv_pct, :total_trades)
    on conflict (symbol, d) do update set
        close = excluded.close,
        volume = excluded.volume,
        deliv_pct = excluded.deliv_pct,
        total_trades = excluded.total_trades
    """
)


DAILY_BAR_BATCH_SIZE = 300
DB_MAX_ATTEMPTS = 3
DB_RETRY_BACKOFF_SECONDS = 2.0


def _execute_batch_with_retry(engine: Engine, batch: list) -> None:
    """Supabase's pooler drops connections mid-batch on occasion (seen live
    while backfilling bhavcopy history) -- a pooled connection can look
    alive at checkout and still die mid-executemany. Retry with a fresh
    connection rather than trust the pool once a batch has failed."""
    last_exc: Exception = RuntimeError("unreachable")
    for attempt in range(1, DB_MAX_ATTEMPTS + 1):
        try:
            with engine.begin() as conn:
                conn.execute(INSERT_DAILY_BAR_SQL, batch)
            return
        except OperationalError as exc:
            last_exc = exc
            engine.dispose()  # discard the whole pool, force fresh connections
            if attempt < DB_MAX_ATTEMPTS:
                time.sleep(DB_RETRY_BACKOFF_SECONDS * attempt)
    raise last_exc


def insert_daily_bars(engine: Engine, bars: pd.DataFrame) -> int:
    """Upserts one day's daily_bars rows (symbol, d unique). Re-running
    the same date is safe -- it just updates the existing rows.

    Batched: a single executemany over ~2600 rows dropped the pooler
    connection outright (Supabase's session pooler on the free tier),
    so this sends a few hundred rows per round trip instead."""
    if bars.empty:
        return 0
    rows = bars.where(pd.notnull(bars), None).to_dict(orient="records")
    for i in range(0, len(rows), DAILY_BAR_BATCH_SIZE):
        _execute_batch_with_retry(engine, rows[i : i + DAILY_BAR_BATCH_SIZE])
    return len(rows)


GET_DAILY_BARS_UPTO_SQL = text(
    """
    select d, close, volume
    from (
        select d, close, volume
        from daily_bars
        where symbol = :symbol and d <= :as_of
        order by d desc
        limit :limit
    ) recent
    order by d asc
    """
)


def get_daily_bars_upto(engine: Engine, symbol: str, as_of: date_type, limit: int) -> list[dict]:
    """The trailing `limit` daily_bars rows for `symbol` ending on or
    before `as_of`, oldest first -- exactly the shape diff.snapshot_state
    wants for `closes`/`volumes`. Fewer than `limit` rows back just means
    less history exists yet; callers decide what to do with that."""
    with engine.connect() as conn:
        rows = conn.execute(GET_DAILY_BARS_UPTO_SQL, {"symbol": symbol, "as_of": as_of, "limit": limit}).mappings().all()
    return [dict(row) for row in rows]


UPSERT_STATE_SNAPSHOT_SQL = text(
    """
    insert into state_snapshots
        (symbol, as_of, volatility_regime, liquidity_regime, beta_to_index, range_position)
    values
        (:symbol, :as_of, :volatility_regime, :liquidity_regime, :beta_to_index, :range_position)
    on conflict (symbol, as_of) do update set
        volatility_regime = excluded.volatility_regime,
        liquidity_regime = excluded.liquidity_regime,
        beta_to_index = excluded.beta_to_index,
        range_position = excluded.range_position,
        computed_at = now()
    returning id
    """
)


def upsert_state_snapshot(engine: Engine, state: StateVector) -> int:
    """Writes one StateVector as a row, keyed on (symbol, as_of) -- a
    snapshot recomputed later (e.g. more history has since arrived)
    overwrites in place rather than accumulating duplicates. Returns the
    row id, needed as statements' from_snapshot_id/to_snapshot_id."""
    with engine.begin() as conn:
        row = conn.execute(
            UPSERT_STATE_SNAPSHOT_SQL,
            {
                "symbol": state.symbol,
                "as_of": state.as_of,
                "volatility_regime": state.volatility_regime,
                "liquidity_regime": state.liquidity_regime,
                "beta_to_index": state.beta_to_index,
                "range_position": state.range_position,
            },
        ).first()
        return row[0]


INSERT_STATEMENT_SQL = text(
    """
    insert into statements
        (user_id, symbol, field, reason, evidence, from_snapshot_id, to_snapshot_id)
    values
        (:user_id, :symbol, :field, :reason, CAST(:evidence AS jsonb), :from_snapshot_id, :to_snapshot_id)
    on conflict (user_id, symbol, field, to_snapshot_id) do nothing
    returning id
    """
)


def insert_statement(
    engine: Engine,
    user_id: str,
    statement: Statement,
    from_snapshot_id: int,
    to_snapshot_id: int,
) -> Optional[int]:
    """Inserts one Statement, deduped on (user_id, symbol, field,
    to_snapshot_id) -- recomputing /api/changed against the same "now"
    snapshot never writes the same statement twice. Returns the new
    row's id, or None if it was already recorded (not an error)."""
    with engine.begin() as conn:
        row = conn.execute(
            INSERT_STATEMENT_SQL,
            {
                "user_id": user_id,
                "symbol": statement.symbol,
                "field": statement.field,
                "reason": statement.reason,
                "evidence": json.dumps(statement.evidence),
                "from_snapshot_id": from_snapshot_id,
                "to_snapshot_id": to_snapshot_id,
            },
        ).first()
        return row[0] if row else None
