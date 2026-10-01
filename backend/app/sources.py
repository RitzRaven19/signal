"""Yahoo Finance fetchers for Signal.

Daily history (beta/residual fitting) and intraday quotes, both tagged with
the source's own `as_of` timestamp and a staleness tier. No persistence
here — callers are responsible for writing whatever they need to the DB.
"""

from __future__ import annotations

import time
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from enum import Enum
from typing import Optional

import httpx

YAHOO_CHART_URL = "https://query1.finance.yahoo.com/v8/finance/chart/{symbol}"

# Yahoo 429s the default httpx UA.
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)

REQUEST_TIMEOUT = httpx.Timeout(10.0, connect=5.0)
MAX_ATTEMPTS = 3
RETRY_BACKOFF_SECONDS = 1.0

# Staleness tier boundaries, in seconds since `as_of`.
LIVE_MAX_AGE = 120
DELAYED_MAX_AGE = 900
STALE_MAX_AGE = 3600


class StalenessTier(str, Enum):
    LIVE = "live"
    DELAYED = "delayed"
    STALE = "stale"
    CLOSED = "closed"   # market shut; as_of is the last session's close -- current, not lagging
    UNKNOWN = "unknown"


IST = timezone(timedelta(hours=5, minutes=30))
NSE_OPEN = (9, 15)
NSE_CLOSE = (15, 30)
# A last-session close stays "closed", not "unknown", across a weekend.
CLOSED_MAX_AGE = 4 * 24 * 3600


def nse_is_open(now: datetime) -> bool:
    """Mon-Fri 09:15-15:30 IST. Exchange holidays aren't modeled -- on a
    holiday this says open, and prices fall through to delayed/stale,
    which errs toward flagging rather than falsely reassuring."""
    t = now.astimezone(IST)
    if t.weekday() >= 5:
        return False
    return NSE_OPEN <= (t.hour, t.minute) < NSE_CLOSE


class SourceError(RuntimeError):
    """Yahoo couldn't be reached, or returned data we can't use."""


@dataclass(frozen=True)
class Quote:
    symbol: str
    price: float
    volume: int
    as_of: datetime          # source's own timestamp — never our clock
    fetched_at: datetime
    source: str
    staleness: StalenessTier
    prev_close: Optional[float] = None


@dataclass(frozen=True)
class DailyBar:
    symbol: str
    d: datetime               # UTC instant of the bar; caller takes .date()
    close: float
    volume: int


def staleness_tier(as_of: Optional[datetime], now: Optional[datetime] = None) -> StalenessTier:
    """While NSE is open: live (<2min) / delayed (<15min) / stale (<60min) /
    unknown (older). While it's shut, a price from the last few days is
    `closed` -- the last close is the current price, not a lagging one."""
    if as_of is None:
        return StalenessTier.UNKNOWN
    now = now or datetime.now(timezone.utc)
    age_seconds = max(0.0, (now - as_of).total_seconds())
    if not nse_is_open(now):
        return StalenessTier.CLOSED if age_seconds < CLOSED_MAX_AGE else StalenessTier.UNKNOWN
    if age_seconds < LIVE_MAX_AGE:
        return StalenessTier.LIVE
    if age_seconds < DELAYED_MAX_AGE:
        return StalenessTier.DELAYED
    if age_seconds < STALE_MAX_AGE:
        return StalenessTier.STALE
    return StalenessTier.UNKNOWN


def _get_with_retry(client: httpx.Client, url: str, params: dict) -> dict:
    last_exc: Optional[Exception] = None
    for attempt in range(1, MAX_ATTEMPTS + 1):
        try:
            resp = client.get(url, params=params, headers={"User-Agent": USER_AGENT})
            if resp.status_code == 429:
                raise SourceError(f"Yahoo rate-limited us (429): {url}")
            resp.raise_for_status()
            return resp.json()
        except (httpx.TransportError, httpx.HTTPStatusError, SourceError) as exc:
            last_exc = exc
            if attempt < MAX_ATTEMPTS:
                time.sleep(RETRY_BACKOFF_SECONDS * attempt)
    raise SourceError(f"Yahoo request failed after {MAX_ATTEMPTS} attempts: {last_exc}") from last_exc


def _extract_result(payload: dict, symbol: str) -> dict:
    try:
        return payload["chart"]["result"][0]
    except (KeyError, IndexError, TypeError) as exc:
        error = (payload or {}).get("chart", {}).get("error")
        raise SourceError(f"No chart data for {symbol}: {error}") from exc


def fetch_daily_history(
    symbol: str,
    range_: str = "6mo",
    client: Optional[httpx.Client] = None,
) -> list[DailyBar]:
    """Daily OHLCV close/volume series, for beta fitting."""
    owns_client = client is None
    client = client or httpx.Client(timeout=REQUEST_TIMEOUT)
    try:
        payload = _get_with_retry(
            client,
            YAHOO_CHART_URL.format(symbol=symbol),
            {"range": range_, "interval": "1d"},
        )
        result = _extract_result(payload, symbol)
        timestamps = result.get("timestamp") or []
        quote = result["indicators"]["quote"][0]
        closes = quote.get("close") or []
        volumes = quote.get("volume") or []

        bars = []
        for ts, close, volume in zip(timestamps, closes, volumes):
            if close is None:
                continue  # Yahoo pads holidays/halts with null rows
            bars.append(
                DailyBar(
                    symbol=symbol,
                    d=datetime.fromtimestamp(ts, tz=timezone.utc),
                    close=float(close),
                    volume=int(volume) if volume is not None else 0,
                )
            )
        return bars
    finally:
        if owns_client:
            client.close()


@dataclass(frozen=True)
class StockChart:
    """Everything a stock page needs from one Yahoo call: the identity and
    day/52-week stats from `meta`, plus daily OHLCV bars."""
    symbol: str
    name: Optional[str]
    exchange: Optional[str]
    currency: Optional[str]
    price: Optional[float]
    prev_close: Optional[float]
    day_high: Optional[float]
    day_low: Optional[float]
    volume: Optional[int]
    week52_high: Optional[float]
    week52_low: Optional[float]
    as_of: Optional[datetime]
    staleness: StalenessTier
    bars: list  # [{"t": iso date, "o","h","l","c": float, "v": int}]


def fetch_stock_chart(symbol: str, range_: str = "1y", client: Optional[httpx.Client] = None) -> StockChart:
    owns_client = client is None
    client = client or httpx.Client(timeout=REQUEST_TIMEOUT)
    try:
        payload = _get_with_retry(client, YAHOO_CHART_URL.format(symbol=symbol), {"range": range_, "interval": "1d"})
        result = _extract_result(payload, symbol)
        meta = result["meta"]
        q = result["indicators"]["quote"][0]
        bars = []
        for i, ts in enumerate(result.get("timestamp") or []):
            c = q["close"][i]
            if c is None:
                continue  # Yahoo pads holidays/halts with null rows
            bars.append({
                "t": datetime.fromtimestamp(ts, tz=timezone.utc).astimezone(IST).date().isoformat(),
                "o": q["open"][i], "h": q["high"][i], "l": q["low"][i], "c": c,
                "v": int(q["volume"][i] or 0),
            })
        as_of = datetime.fromtimestamp(meta["regularMarketTime"], tz=timezone.utc) if meta.get("regularMarketTime") else None
        price = meta.get("regularMarketPrice")
        # Yahoo's daily bars can lag its live price by a day (seen: last bar
        # Sept 30 while the price was Oct 1's). If so, the last bar IS the
        # previous close, and today's point is appended from meta so the
        # chart reaches the current price.
        as_of_day = as_of.astimezone(IST).date().isoformat() if as_of else None
        if bars and price is not None and as_of_day and bars[-1]["t"] < as_of_day:
            prev_close = bars[-1]["c"]
            bars.append({
                "t": as_of_day, "o": None, "h": meta.get("regularMarketDayHigh"),
                "l": meta.get("regularMarketDayLow"), "c": price, "v": int(meta.get("regularMarketVolume") or 0),
            })
        else:
            prev_close = bars[-2]["c"] if len(bars) >= 2 else None
        return StockChart(
            symbol=symbol,
            name=meta.get("longName") or meta.get("shortName"),
            exchange=meta.get("fullExchangeName"),
            currency=meta.get("currency"),
            price=price,
            prev_close=prev_close,
            day_high=meta.get("regularMarketDayHigh"),
            day_low=meta.get("regularMarketDayLow"),
            volume=meta.get("regularMarketVolume"),
            week52_high=meta.get("fiftyTwoWeekHigh"),
            week52_low=meta.get("fiftyTwoWeekLow"),
            as_of=as_of,
            staleness=staleness_tier(as_of),
            bars=bars,
        )
    finally:
        if owns_client:
            client.close()


def fetch_intraday_quote(symbol: str, client: Optional[httpx.Client] = None) -> Quote:
    """Latest quote off the 1d/5m chart. `as_of` is meta.regularMarketTime, not our clock."""
    owns_client = client is None
    client = client or httpx.Client(timeout=REQUEST_TIMEOUT)
    try:
        payload = _get_with_retry(
            client,
            YAHOO_CHART_URL.format(symbol=symbol),
            {"range": "1d", "interval": "5m"},
        )
        result = _extract_result(payload, symbol)
        meta = result["meta"]
        price = meta.get("regularMarketPrice")
        as_of_epoch = meta.get("regularMarketTime")
        if price is None or as_of_epoch is None:
            raise SourceError(f"Incomplete quote meta for {symbol}: {meta}")

        as_of = datetime.fromtimestamp(as_of_epoch, tz=timezone.utc)
        fetched_at = datetime.now(timezone.utc)

        quote_block = result.get("indicators", {}).get("quote", [{}])[0]
        volumes = quote_block.get("volume") or []
        volume = next((v for v in reversed(volumes) if v is not None), 0)

        prev_close = meta.get("previousClose", meta.get("chartPreviousClose"))

        return Quote(
            symbol=symbol,
            price=float(price),
            volume=int(volume),
            as_of=as_of,
            fetched_at=fetched_at,
            source="yahoo",
            staleness=staleness_tier(as_of, fetched_at),
            prev_close=float(prev_close) if prev_close is not None else None,
        )
    finally:
        if owns_client:
            client.close()


if __name__ == "__main__":
    q = fetch_intraday_quote("RELIANCE.NS")
    print(q)

    bars = fetch_daily_history("RELIANCE.NS")
    print(f"{len(bars)} daily bars, latest: {bars[-1] if bars else None}")
