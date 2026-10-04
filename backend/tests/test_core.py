"""Regression tests for bugs found in production, plus the core maths.

No database or network: every external call is faked. Run from backend/:
    pytest
"""

from datetime import date, datetime, timedelta, timezone

import pytest

from app import ai, bhavcopy, funds, sources
from app.sources import IST, StalenessTier, staleness_tier

# ── bhavcopy: trust the date inside the file ──────────────────────────

HEADER = "SYMBOL, SERIES, DATE1, PREV_CLOSE, OPEN_PRICE, HIGH_PRICE, LOW_PRICE, LAST_PRICE, CLOSE_PRICE, AVG_PRICE, TTL_TRD_QNTY, TURNOVER_LACS, NO_OF_TRADES, DELIV_QTY, DELIV_PER\n"


def _bhavcopy(tmp_path, monkeypatch, file_date: str):
    path = tmp_path / "bhav.csv"
    path.write_text(
        HEADER
        + f"TCS, EQ, {file_date}, 2050.0, 2051, 2080, 2040, 2075, 2075.0, 2060, 1000, 20.6, 50, 600, 60.00\n"
        + f"NIFTYBEES, BE, {file_date}, 1, 1, 1, 1, 1, 1.0, 1, 10, 0.1, 1, 5, 50.00\n"
    )
    monkeypatch.setattr(bhavcopy, "fetch_delivery_bhavcopy", lambda d: path)


def test_bhavcopy_loads_matching_day(tmp_path, monkeypatch):
    _bhavcopy(tmp_path, monkeypatch, "01-Oct-2026")
    df = bhavcopy.load_daily_bars(datetime(2026, 10, 1))
    assert list(df["symbol"]) == ["TCS.NS"]  # EQ series only, .NS suffix
    assert df.iloc[0]["close"] == 2075.0 and df.iloc[0]["deliv_pct"] == 60.0
    assert df.iloc[0]["d"] == date(2026, 10, 1)


def test_bhavcopy_rejects_file_from_another_day(tmp_path, monkeypatch):
    # Oct 2 2026 was a holiday; the source served Oct 1's file and it was
    # stored as Oct 2 -- a fake day where every stock moved 0%.
    _bhavcopy(tmp_path, monkeypatch, "01-Oct-2026")
    with pytest.raises(bhavcopy.BhavcopyUnavailable):
        bhavcopy.load_daily_bars(datetime(2026, 10, 2))


# ── staleness tiers ───────────────────────────────────────────────────

def _ist(y, m, d, hh, mm):
    return datetime(y, m, d, hh, mm, tzinfo=IST)


def test_staleness_while_market_open():
    now = _ist(2026, 10, 5, 11, 0)  # Monday 11:00 IST
    assert staleness_tier(now - timedelta(seconds=30), now) == StalenessTier.LIVE
    assert staleness_tier(now - timedelta(minutes=5), now) == StalenessTier.DELAYED
    assert staleness_tier(now - timedelta(minutes=30), now) == StalenessTier.STALE
    assert staleness_tier(None, now) == StalenessTier.UNKNOWN


def test_last_close_is_closed_not_stale_overnight_and_weekend():
    friday_close = _ist(2026, 10, 2, 15, 30)
    assert staleness_tier(friday_close, _ist(2026, 10, 2, 22, 0)) == StalenessTier.CLOSED
    assert staleness_tier(friday_close, _ist(2026, 10, 4, 22, 0)) == StalenessTier.CLOSED  # Sunday
    assert staleness_tier(friday_close, _ist(2026, 10, 10, 10, 0)) != StalenessTier.CLOSED  # a week later, open


# ── Yahoo: daily bars can lag the live price by a day ─────────────────

def _yahoo(monkeypatch, last_bar_day: date, as_of: datetime, price: float):
    ts = [int(datetime(last_bar_day.year, last_bar_day.month, last_bar_day.day, 4, tzinfo=timezone.utc).timestamp()) - 86400 * i for i in (1, 0)]
    payload = {"chart": {"result": [{
        "meta": {"regularMarketPrice": price, "regularMarketTime": int(as_of.timestamp()), "regularMarketDayHigh": price, "regularMarketDayLow": price, "regularMarketVolume": 10},
        "timestamp": ts,
        "indicators": {"quote": [{"open": [1, 1], "high": [1, 1], "low": [1, 1], "close": [100.0, 110.0], "volume": [5, 5]}]},
    }]}}
    monkeypatch.setattr(sources, "_get_with_retry", lambda client, url, params: payload)


def test_chart_appends_today_when_bars_lag(monkeypatch):
    _yahoo(monkeypatch, date(2026, 9, 30), _ist(2026, 10, 1, 15, 30), 121.0)
    chart = sources.fetch_stock_chart("X.NS", client=object())
    assert chart.bars[-1]["t"] == "2026-10-01" and chart.bars[-1]["c"] == 121.0
    assert chart.prev_close == 110.0  # the lagging last bar IS yesterday's close


def test_chart_uses_second_last_bar_when_current(monkeypatch):
    _yahoo(monkeypatch, date(2026, 10, 1), _ist(2026, 10, 1, 15, 30), 110.0)
    chart = sources.fetch_stock_chart("X.NS", client=object())
    assert len(chart.bars) == 2 and chart.prev_close == 100.0


# ── mutual fund returns ───────────────────────────────────────────────

def test_fund_returns_absolute_then_cagr():
    start = date(2020, 1, 1)
    # NAV climbs in a straight line from 10 to 20 over exactly 3 years
    series = [{"d": start + timedelta(days=i), "c": 10.0 + 10.0 * i / 1095} for i in range(0, 1096)]
    r = funds._returns(series)
    assert r["1y"] == pytest.approx(20 / (10 + 10 * 730 / 1095) - 1)  # absolute: +20%
    assert r["3y"] == pytest.approx(2 ** (365 / 1095) - 1)  # doubled in 3y -> ~26% a year
    assert r["5y"] is None  # fund isn't 5 years old


# ── AI explainer ──────────────────────────────────────────────────────

class _Resp:
    def __init__(self, status=200, text="ok!"):
        self.status_code = status
        self._text = text

    def json(self):
        return {"candidates": [{"content": {"parts": [{"text": self._text}]}}]}


@pytest.fixture
def gemini(monkeypatch):
    calls = []
    responses = []

    def fake_post(url, headers=None, json=None, timeout=None):
        calls.append({"url": url, "body": json, "key": headers.get("x-goog-api-key")})
        return responses.pop(0) if responses else _Resp()

    monkeypatch.setenv("GEMINI_API_KEY", "test-key")
    monkeypatch.setattr(ai.httpx, "post", fake_post)
    monkeypatch.setattr(ai, "_cache", {})
    monkeypatch.setattr(ai, "_visitor_hits", ai.defaultdict(ai.deque))
    monkeypatch.setattr(ai, "_day", {"date": None, "count": 0})
    return calls, responses


def _ask(visitor="v", history=(), question=""):
    return ai.explain(visitor=visitor, title="RSI", about="momentum", context="RSI 45", history=list(history), question=question)


def test_ai_without_key_falls_back(monkeypatch):
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    with pytest.raises(ai.AIUnavailable):
        _ask()


def test_ai_turns_alternate_and_end_with_the_question(gemini):
    calls, _ = gemini
    _ask(history=[{"role": "model", "text": "a0"}, {"role": "user", "text": "q1"}, {"role": "model", "text": "a1"}], question="q2")
    contents = calls[0]["body"]["contents"]
    roles = [c["role"] for c in contents]
    assert roles == ["user", "model", "user", "model", "user"]
    assert contents[-1]["parts"][0]["text"] == "q2"
    assert "RSI 45" in contents[0]["parts"][0]["text"]  # on-screen numbers reach the model
    assert calls[0]["body"]["generationConfig"]["thinkingConfig"] == {"thinkingBudget": 0}


def test_ai_retries_on_overload_with_second_model(gemini):
    calls, responses = gemini
    responses += [_Resp(503), _Resp(200, "from fallback")]
    assert _ask() == "from fallback"
    assert ai.DEFAULT_MODEL in calls[0]["url"] and ai.FALLBACK_MODEL in calls[1]["url"]


def test_ai_caches_first_questions(gemini):
    calls, _ = gemini
    assert _ask() == _ask()
    assert len(calls) == 1


def test_ai_per_visitor_limit(gemini):
    for i in range(ai.PER_VISITOR_LIMIT):
        _ask(question=f"q{i}")  # distinct questions, so no cache hits
    with pytest.raises(ai.AIUnavailable):
        _ask(question="one too many")
    _ask(visitor="someone-else", question="fine")  # other visitors unaffected
