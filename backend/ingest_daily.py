"""Daily ingestion: bring daily_bars up to date and run the EOD detectors.

Finds every weekday in the last LOOKBACK_DAYS (IST) that has no rows in
daily_bars -- not just days after the latest stored date, so a day that
failed mid-run is retried next time instead of becoming a permanent gap
behind newer data. For each: loads NSE's delivery bhavcopy, upserts the
rows, then runs bhavcopy.scan_for_events (DELIVERY_CONVICTION and
BLOCK_TRADE). Real holidays just come back "not published" each run.

Run once a day after the bhavcopy is published (~18:00 IST):
    python ingest_daily.py
Exits non-zero if any day failed for a reason other than "not published".
"""

from __future__ import annotations

import sys
import time
from datetime import datetime, timedelta, timezone

from sqlalchemy import text

from app import bhavcopy, instruments, models
from app.db import get_engine

IST = timezone(timedelta(hours=5, minutes=30))
REQUEST_PAUSE_SECONDS = 0.6
LOOKBACK_DAYS = 30


def main() -> int:
    engine = get_engine()
    try:
        print("instruments:", instruments.refresh_instruments(engine))
    except Exception as exc:  # noqa: BLE001 -- yesterday's list is still usable
        print(f"instruments refresh FAILED (keeping the previous list) -- {exc}")
    today = datetime.now(IST).date()
    start = today - timedelta(days=LOOKBACK_DAYS)
    with engine.connect() as conn:
        have = {
            row[0]
            for row in conn.execute(text("select distinct d from daily_bars where d >= :start"), {"start": start})
        }

    window = [start + timedelta(days=i) for i in range(LOOKBACK_DAYS + 1)]
    days = [d for d in window if d.weekday() < 5 and d not in have]

    print(f"{len(days)} weekday(s) missing in the last {LOOKBACK_DAYS} days: {[str(d) for d in days]}")
    failed = 0
    for d in days:
        when = datetime(d.year, d.month, d.day)
        try:
            n = models.insert_daily_bars(engine, bhavcopy.load_daily_bars(when))
            events = bhavcopy.scan_for_events(engine, when)
            print(f"{d}: {n} bars, {events} new event(s)")
        except bhavcopy.BhavcopyUnavailable:
            print(f"{d}: not published (holiday, or not out yet)")
        except Exception as exc:  # noqa: BLE001 -- log, keep going, report via exit code
            failed += 1
            print(f"{d}: FAILED -- {exc}")
        time.sleep(REQUEST_PAUSE_SECONDS)

    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
