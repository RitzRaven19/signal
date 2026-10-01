"""Indian mutual funds via mfapi.in -- a free, keyless mirror of AMFI's
daily NAV files.

Proxied through our API (rather than called from the browser) so the
full NAV history is fetched once an hour per fund, not once per visitor,
and so returns are computed in one place.
"""

from __future__ import annotations

import time
from datetime import date, datetime, timedelta
from typing import Optional

import httpx

MFAPI = "https://api.mfapi.in/mf"
CACHE_SECONDS = 3600
TIMEOUT = 20

_cache: dict[int, tuple[float, dict]] = {}


class FundError(RuntimeError):
    pass


def search_funds(q: str, limit: int = 15) -> list[dict]:
    q = q.strip()
    if len(q) < 2:
        return []
    try:
        r = httpx.get(f"{MFAPI}/search", params={"q": q}, timeout=TIMEOUT)
        r.raise_for_status()
        rows = r.json()
    except (httpx.HTTPError, ValueError) as exc:
        raise FundError(f"fund search failed: {exc}") from exc
    # Growth plans first (what most people mean), Direct before Regular.
    def rank(row):
        name = row["schemeName"].lower()
        return ("growth" not in name, "direct" not in name, name)

    return [{"code": row["schemeCode"], "name": row["schemeName"]} for row in sorted(rows, key=rank)[:limit]]


def _nav_on_or_before(series: list[dict], target: date) -> Optional[dict]:
    """Latest NAV point dated on or before `target` (series is ascending)."""
    lo, hi, found = 0, len(series) - 1, None
    while lo <= hi:
        mid = (lo + hi) // 2
        if series[mid]["d"] <= target:
            found, lo = series[mid], mid + 1
        else:
            hi = mid - 1
    return found


def _returns(series: list[dict]) -> dict:
    """Absolute returns up to 1 year, annualised (CAGR) beyond -- the same
    convention AMFI factsheets and Groww use."""
    last = series[-1]
    out = {}
    for key, days, annualise in (
        ("1m", 30, False), ("3m", 91, False), ("6m", 182, False), ("1y", 365, False),
        ("3y", 365 * 3, True), ("5y", 365 * 5, True),
    ):
        base = _nav_on_or_before(series, last["d"] - timedelta(days=days))
        if base is None:  # the fund didn't exist that far back
            out[key] = None
            continue
        growth = last["c"] / base["c"]
        out[key] = growth ** (365 / days) - 1 if annualise else growth - 1
    years = (last["d"] - series[0]["d"]).days / 365
    out["since_launch"] = (last["c"] / series[0]["c"]) ** (1 / years) - 1 if years >= 1 else None
    return out


def get_fund(code: int) -> dict:
    hit = _cache.get(code)
    if hit and time.time() - hit[0] < CACHE_SECONDS:
        return hit[1]
    try:
        r = httpx.get(f"{MFAPI}/{code}", timeout=TIMEOUT)
        r.raise_for_status()
        payload = r.json()
    except (httpx.HTTPError, ValueError) as exc:
        raise FundError(f"fund {code} unavailable: {exc}") from exc
    meta = payload.get("meta") or {}
    series = []
    for p in payload.get("data") or []:
        try:
            nav = float(p["nav"])
        except (KeyError, ValueError):
            continue
        if nav <= 0:
            continue  # AMFI pads some suspended days with 0
        series.append({"d": datetime.strptime(p["date"], "%d-%m-%Y").date(), "c": nav})
    if not series or not meta.get("scheme_name"):
        raise FundError(f"no NAV history for fund {code}")
    series.sort(key=lambda p: p["d"])
    last = series[-1]
    prev = series[-2] if len(series) > 1 else None
    fund = {
        "code": code,
        "name": meta.get("scheme_name"),
        "fund_house": meta.get("fund_house"),
        "category": meta.get("scheme_category"),
        "type": meta.get("scheme_type"),
        "nav": last["c"],
        "nav_date": last["d"].isoformat(),
        "day_change": last["c"] / prev["c"] - 1 if prev else None,
        "launched": series[0]["d"].isoformat(),
        "returns": _returns(series),
        "bars": [{"t": p["d"].isoformat(), "c": p["c"]} for p in series],
    }
    _cache[code] = (time.time(), fund)
    return fund
