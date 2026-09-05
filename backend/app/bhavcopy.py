"""NSE bhavcopy ingestion for Signal.

The delivery bhavcopy (NSE's sec_bhavdata_full report) already carries
OHLC, traded volume, trade count AND delivery % in one file, so
PLAN.md's separate equityBhavcopy call isn't needed just to populate
daily_bars -- one download a day instead of two.

Non-negotiables: NSE requests stay well under 3 req/sec (the `nse`
package's own client handles pacing; callers here fetch one date at a
time), everything downloaded is cached under data/ and never
re-fetched, and no persistence happens here -- see models.py.
"""

from __future__ import annotations

import time
from datetime import datetime, timezone
from pathlib import Path
from typing import List

import httpx
import pandas as pd
from sqlalchemy import text
from sqlalchemy.engine import Engine
from nse import NSE

from . import detector
from . import models

DATA_DIR = Path(__file__).resolve().parent.parent / "data"
MAX_ATTEMPTS = 3
RETRY_BACKOFF_SECONDS = 2.0


class BhavcopyUnavailable(RuntimeError):
    """Raised when NSE has no bhavcopy for a date (weekend/holiday/not yet published)."""


def _delivery_bhavcopy_path(date: datetime) -> Path:
    return DATA_DIR / f"sec_bhavdata_full_{date.strftime('%d%m%Y')}.csv"


def fetch_delivery_bhavcopy(date: datetime) -> Path:
    """Returns the cached delivery bhavcopy for `date`, downloading it only
    if we don't already have it on disk."""
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    cached = _delivery_bhavcopy_path(date)
    if cached.is_file():
        return cached

    last_exc: Exception = RuntimeError("unreachable")
    for attempt in range(1, MAX_ATTEMPTS + 1):
        try:
            with NSE(download_folder=str(DATA_DIR)) as nse:
                return nse.deliveryBhavcopy(date)
        except (FileNotFoundError, RuntimeError) as exc:
            # NSE has no bhavcopy for this date (weekend/holiday/not yet
            # published) -- retrying won't help, fail fast.
            raise BhavcopyUnavailable(f"No delivery bhavcopy for {date.date()}: {exc}") from exc
        except (httpx.TransportError, httpx.HTTPStatusError) as exc:
            # NSE's WAF resets connections on occasion -- transient, retry.
            last_exc = exc
            if attempt < MAX_ATTEMPTS:
                time.sleep(RETRY_BACKOFF_SECONDS * attempt)
    raise BhavcopyUnavailable(
        f"Delivery bhavcopy request for {date.date()} failed after {MAX_ATTEMPTS} attempts: {last_exc}"
    ) from last_exc


def load_daily_bars(date: datetime) -> pd.DataFrame:
    """Parses a date's delivery bhavcopy into one row per equity (SERIES
    == 'EQ') symbol, in Yahoo's .NS-suffixed form so it joins cleanly
    with the rest of the app: symbol, d, close, volume, deliv_pct,
    total_trades."""
    path = fetch_delivery_bhavcopy(date)
    df = pd.read_csv(path, skipinitialspace=True)
    df = df[df["SERIES"] == "EQ"].copy()

    out = pd.DataFrame(
        {
            "symbol": df["SYMBOL"].str.strip() + ".NS",
            "close": df["CLOSE_PRICE"].astype(float),
            "volume": df["TTL_TRD_QNTY"].astype("int64"),
            "total_trades": df["NO_OF_TRADES"].astype("int64"),
            "deliv_pct": pd.to_numeric(df["DELIV_PER"], errors="coerce"),
        }
    )
    out["d"] = date.date()
    return out


_VOL_MEDIAN_20D_SQL = text(
    """
    select symbol, percentile_cont(0.5) within group (order by volume) as vol_median_20d
    from (
        select symbol, volume, row_number() over (partition by symbol order by d desc) as rn
        from daily_bars
        where d < :date
    ) recent
    where rn <= 20
    group by symbol
    """
)

_MEDIAN_AVG_TRADE_SIZE_SQL = text(
    """
    select percentile_cont(0.5) within group (order by volume::float / nullif(total_trades, 0))
        as median_avg_trade_size
    from daily_bars
    where d = :date and total_trades > 0
    """
)

_TODAY_BARS_SQL = text(
    "select symbol, volume, deliv_pct, total_trades from daily_bars where d = :date"
)


def scan_for_events(engine: Engine, date: datetime) -> int:
    """Runs DELIVERY_CONVICTION and BLOCK_TRADE across every symbol in
    that date's daily_bars, against the trailing 20-day median volume
    (per symbol) and that day's cross-sectional median trade size.
    Returns how many new events were inserted (fingerprint-deduped, so
    re-running the same date is a no-op)."""
    occurred_at = datetime(date.year, date.month, date.day, 10, 0, tzinfo=timezone.utc)  # ~15:30 IST close

    with engine.connect() as conn:
        vol_medians = {
            row.symbol: row.vol_median_20d
            for row in conn.execute(_VOL_MEDIAN_20D_SQL, {"date": date.date()})
        }
        median_trade_size = conn.execute(_MEDIAN_AVG_TRADE_SIZE_SQL, {"date": date.date()}).scalar()
        today_rows = conn.execute(_TODAY_BARS_SQL, {"date": date.date()}).mappings().all()

    inserted = 0
    for row in today_rows:
        vol_median_20d = vol_medians.get(row["symbol"])
        if vol_median_20d:
            event = detector.detect_delivery_conviction(
                row["symbol"], row["volume"], row["deliv_pct"], vol_median_20d, occurred_at
            )
            if event and models.insert_event(engine, event) is not None:
                inserted += 1

        if median_trade_size:
            event = detector.detect_block_trade(
                row["symbol"], row["volume"], row["total_trades"], median_trade_size, occurred_at
            )
            if event and models.insert_event(engine, event) is not None:
                inserted += 1

    return inserted
