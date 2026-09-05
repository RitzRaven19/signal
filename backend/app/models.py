"""Events table access for Signal.

Plain SQL, no ORM -- the schema lives in Supabase (applied via migration),
not here. This module just reads/writes rows, deduping on `fingerprint`
so a detector re-scoring the same tick never produces a second event.
"""

from __future__ import annotations

import json
import time
from typing import Optional

import pandas as pd
from sqlalchemy import text
from sqlalchemy.engine import Engine
from sqlalchemy.exc import OperationalError

from .detector import Event

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
