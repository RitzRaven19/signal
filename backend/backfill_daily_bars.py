"""One-off backfill: extend daily_bars further back in history so
diff.py's snapshot_state() (needs >=40 trading days) actually has
enough to compute volatility_regime/liquidity_regime/range_position
instead of reporting insufficient_history for every symbol.

Not part of the app's import chain -- run manually:
    python backfill_daily_bars.py [n_calendar_days]

Only touches daily_bars (via bhavcopy.load_daily_bars +
models.insert_daily_bars). Does not run scan_for_events -- backfilled
history is for beta/regime fitting, not for generating alerts on
months-old ticks.
"""

from __future__ import annotations

import sys
import time
from datetime import datetime, timedelta

from sqlalchemy import text

from app import bhavcopy, models
from app.db import get_engine

REQUEST_PAUSE_SECONDS = 0.6  # courteous spacing on top of the nse package's own pacing


def existing_date_range(engine) -> tuple[datetime, datetime]:
    with engine.connect() as conn:
        row = conn.execute(text("select min(d) as earliest, max(d) as latest from daily_bars")).first()
    return row.earliest, row.latest


def main() -> None:
    n_calendar_days = int(sys.argv[1]) if len(sys.argv) > 1 else 140
    engine = get_engine()

    earliest, latest = existing_date_range(engine)
    print(f"existing daily_bars range: {earliest} .. {latest}")

    start = datetime(earliest.year, earliest.month, earliest.day) - timedelta(days=1)
    candidates = [start - timedelta(days=i) for i in range(n_calendar_days)]
    candidates = [d for d in candidates if d.weekday() < 5]  # Mon-Fri only

    fetched, skipped, failed = 0, 0, 0
    for d in candidates:
        try:
            df = bhavcopy.load_daily_bars(d)
            n = models.insert_daily_bars(engine, df)
            fetched += 1
            print(f"{d.date()}: {n} rows")
        except bhavcopy.BhavcopyUnavailable:
            skipped += 1
            print(f"{d.date()}: no bhavcopy (holiday/weekend)")
        except Exception as exc:  # noqa: BLE001 -- backfill script, log and keep going
            failed += 1
            print(f"{d.date()}: FAILED -- {exc}")
        time.sleep(REQUEST_PAUSE_SECONDS)

    new_earliest, new_latest = existing_date_range(engine)
    print(f"\ndone. fetched={fetched} skipped(holiday/weekend)={skipped} failed={failed}")
    print(f"daily_bars range is now: {new_earliest} .. {new_latest}")


if __name__ == "__main__":
    main()
