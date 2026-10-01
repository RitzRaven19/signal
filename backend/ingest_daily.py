"""Daily ingestion: bring daily_bars up to date and run the EOD detectors.

Finds every weekday after the latest date already in daily_bars, up to
today (IST), and for each one: loads NSE's delivery bhavcopy, upserts
the rows, then runs bhavcopy.scan_for_events (DELIVERY_CONVICTION and
BLOCK_TRADE). Days NSE hasn't published (holidays, or today before the
evening release) are skipped and picked up on the next run, so missing
a day never leaves a permanent gap.

Run once a day after the bhavcopy is published (~18:00 IST):
    python ingest_daily.py
Exits non-zero if any day failed for a reason other than "not published".
"""

from __future__ import annotations

import sys
import time
from datetime import datetime, timedelta, timezone

from sqlalchemy import text

from app import bhavcopy, models
from app.db import get_engine

IST = timezone(timedelta(hours=5, minutes=30))
REQUEST_PAUSE_SECONDS = 0.6
MAX_CATCHUP_DAYS = 60  # a first run on an empty table shouldn't try to fetch forever


def main() -> int:
    engine = get_engine()
    with engine.connect() as conn:
        latest = conn.execute(text("select max(d) from daily_bars")).scalar()

    today = datetime.now(IST).date()
    start = (latest + timedelta(days=1)) if latest else today - timedelta(days=MAX_CATCHUP_DAYS)
    days = [start + timedelta(days=i) for i in range((today - start).days + 1)]
    days = [d for d in days if d.weekday() < 5][-MAX_CATCHUP_DAYS:]

    print(f"latest in daily_bars: {latest}; checking {len(days)} weekday(s) through {today}")
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
