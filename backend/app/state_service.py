"""Wires diff.py's pure functions to real data.

diff.py never touches the DB or the network -- this module is the I/O
layer around it: stock history comes from daily_bars (models.py), index
history comes live from Yahoo (sources.py, since no index series is
ingested anywhere yet -- see the audit), and results are persisted via
models.py's state_snapshots/statements helpers.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date as date_type

import httpx

from sqlalchemy.engine import Engine

from . import models, sources
from .diff import DEFAULT_WINDOW, StateVector, snapshot_state

INDEX_SYMBOL = "^NSEI"
STATE_FIELDS = ("volatility_regime", "liquidity_regime", "beta_to_index", "range_position")


@dataclass(frozen=True)
class SymbolState:
    state: StateVector
    days_available: int
    blocked_fields: tuple  # StateVector fields that came back None
    fully_blocked: bool     # every computed field is None -- nothing to say about this symbol at all


def get_index_closes(client: httpx.Client, window: int = DEFAULT_WINDOW) -> list[float]:
    """Live NIFTY closes for beta fitting. Callers fetch this once per
    request and reuse it across every watchlist symbol -- fetching it
    per-symbol would multiply Yahoo calls for no reason, and caching it
    across requests would go stale for as long as the process runs."""
    try:
        bars = sources.fetch_daily_history(INDEX_SYMBOL, range_="6mo", client=client)
    except sources.SourceError:
        return []
    return [b.close for b in bars]


def compute_symbol_state(
    engine: Engine,
    symbol: str,
    as_of: date_type,
    index_closes: list[float],
    window: int = DEFAULT_WINDOW,
) -> SymbolState:
    """Reads symbol's trailing daily_bars up to `as_of`, pairs it with
    the already-fetched index series, and runs diff.snapshot_state.
    Doesn't persist anything -- callers decide whether/when to write."""
    bars = models.get_daily_bars_upto(engine, symbol, as_of, limit=window * 3)
    closes = [b["close"] for b in bars]
    volumes = [b["volume"] for b in bars]
    # Pair against the same trailing length the stock has, not the full
    # 6mo of index history -- a 10-day-old stock listing shouldn't be
    # beta-fit against 6 months of index moves it wasn't there for.
    aligned_index = index_closes[-len(closes):] if closes else []

    state = snapshot_state(symbol, as_of, closes, volumes, aligned_index, window=window)
    blocked = tuple(f for f in STATE_FIELDS if getattr(state, f) is None)
    return SymbolState(
        state=state,
        days_available=len(closes),
        blocked_fields=blocked,
        fully_blocked=len(blocked) == len(STATE_FIELDS),
    )
