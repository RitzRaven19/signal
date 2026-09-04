"""Events table access for Signal.

Plain SQL, no ORM -- the schema lives in Supabase (applied via migration),
not here. This module just reads/writes rows, deduping on `fingerprint`
so a detector re-scoring the same tick never produces a second event.
"""

from __future__ import annotations

import json
from typing import Optional

from sqlalchemy import text
from sqlalchemy.engine import Engine

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
