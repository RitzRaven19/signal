"""Database engine for Signal.

Plain SQLAlchemy Core against Postgres (Supabase) -- no ORM models, no
migration framework here. Schema changes are applied directly against
Supabase; this module only opens connections.
"""

from __future__ import annotations

import os
from typing import Optional

from dotenv import load_dotenv
from sqlalchemy import create_engine
from sqlalchemy.engine import Engine

load_dotenv()

DATABASE_URL = os.environ.get("DATABASE_URL")

_engine: Optional[Engine] = None


def get_engine() -> Engine:
    """Lazily creates and caches the SQLAlchemy engine."""
    global _engine
    if _engine is None:
        if not DATABASE_URL:
            raise RuntimeError("DATABASE_URL is not set (check your .env)")
        _engine = create_engine(DATABASE_URL, pool_pre_ping=True)
    return _engine
