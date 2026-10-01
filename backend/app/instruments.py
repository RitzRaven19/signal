"""NSE's official instrument lists -> the instruments table.

EQUITY_L.csv lists every listed company (symbol + name); eq_etfseclist.csv
lists every ETF. NSE's equity bhavcopy mixes ETFs in with company shares,
so without this the market scans fill up with bond/gold/silver ETFs, and
search can only match ticker symbols, not company names.
"""

from __future__ import annotations

import csv
import io

import httpx
from sqlalchemy import text
from sqlalchemy.engine import Engine

from .sources import USER_AGENT

EQUITY_LIST_URL = "https://nsearchives.nseindia.com/content/equities/EQUITY_L.csv"
ETF_LIST_URL = "https://nsearchives.nseindia.com/content/equities/eq_etfseclist.csv"

UPSERT_SQL = text(
    """
    insert into instruments (symbol, name, kind)
    select symbol, name, kind from jsonb_to_recordset(CAST(:rows AS jsonb)) as r(symbol text, name text, kind text)
    on conflict (symbol) do update set name = excluded.name, kind = excluded.kind, updated_at = now()
    """
)


def _fetch_csv(client: httpx.Client, url: str) -> list[dict]:
    resp = client.get(url, headers={"User-Agent": USER_AGENT}, timeout=30, follow_redirects=True)
    resp.raise_for_status()
    reader = csv.DictReader(io.StringIO(resp.text))
    # NSE's headers carry stray leading spaces (" SERIES") -- normalise them.
    return [{(k or "").strip(): (v or "").strip() for k, v in row.items()} for row in reader]


def refresh_instruments(engine: Engine) -> dict:
    import json

    with httpx.Client() as client:
        equities = _fetch_csv(client, EQUITY_LIST_URL)
        etfs = _fetch_csv(client, ETF_LIST_URL)

    rows = {}
    for r in equities:
        if r.get("SYMBOL") and r.get("NAME OF COMPANY"):
            rows[r["SYMBOL"] + ".NS"] = {"symbol": r["SYMBOL"] + ".NS", "name": r["NAME OF COMPANY"], "kind": "equity"}
    for r in etfs:
        if r.get("Symbol"):
            name = r.get("SecurityName") or r.get("Underlying Asset") or r["Symbol"]
            rows[r["Symbol"] + ".NS"] = {"symbol": r["Symbol"] + ".NS", "name": name, "kind": "etf"}

    with engine.begin() as conn:
        conn.execute(UPSERT_SQL, {"rows": json.dumps(list(rows.values()))})
    return {"equities": sum(1 for r in rows.values() if r["kind"] == "equity"), "etfs": sum(1 for r in rows.values() if r["kind"] == "etf")}
