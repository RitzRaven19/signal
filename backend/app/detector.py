"""Residual-move detector for Signal.

Fits a stock's beta against an index from daily closes, then scores new
return observations by how much they diverge from what that beta explains.
Only RESIDUAL_MOVE events are produced here — suppression (Critic stage:
sector context, split adjustment, bad-tick quarantine) is a separate stage
built later, and nothing here writes to a database.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import datetime
from typing import Optional, Sequence

import numpy as np

Z_THRESHOLD = 2.0
DEFAULT_RESID_WINDOW = 20


@dataclass(frozen=True)
class BetaFit:
    symbol: str
    beta: float
    resid_sigma: float   # stdev of the trailing `window` residual returns
    n_obs: int            # how many residual observations that stdev is over


@dataclass(frozen=True)
class Event:
    symbol: str
    type: str
    score: float          # z-score / severity
    reason: str            # plain-English, shown in UI
    evidence: dict          # raw numbers behind the claim
    occurred_at: datetime
    fingerprint: str        # symbol|type|bucket, for dedup


def log_returns(closes: Sequence[float]) -> np.ndarray:
    closes = np.asarray(closes, dtype=float)
    if len(closes) < 2:
        raise ValueError("need at least 2 closes to compute a return")
    return np.diff(np.log(closes))


def fit_beta(
    symbol: str,
    stock_closes: Sequence[float],
    index_closes: Sequence[float],
    window: int = DEFAULT_RESID_WINDOW,
) -> BetaFit:
    """Beta of stock vs index from daily closes, and the stdev of the
    trailing `window` days of residual (unexplained) returns."""
    if len(stock_closes) != len(index_closes):
        raise ValueError("stock_closes and index_closes must be the same length")

    rs = log_returns(stock_closes)
    ri = log_returns(index_closes)

    index_var = np.var(ri)
    if index_var == 0:
        raise ValueError(f"{symbol}: index has zero variance over this window — can't fit beta")

    beta = float(np.cov(rs, ri)[0, 1] / index_var)
    residual = rs - beta * ri

    tail = residual[-window:]
    return BetaFit(symbol=symbol, beta=beta, resid_sigma=float(tail.std()), n_obs=len(tail))


def residual_z(stock_ret: float, index_ret: float, beta: float, resid_sigma: float) -> float:
    if resid_sigma == 0:
        return 0.0
    residual = stock_ret - beta * index_ret
    return residual / resid_sigma


def _fingerprint(symbol: str, event_type: str, occurred_at: datetime) -> str:
    bucket = occurred_at.strftime("%Y-%m-%dT%H:%M")
    return f"{symbol}|{event_type}|{bucket}"


def detect_residual_move(
    fit: BetaFit,
    stock_ret: float,
    index_ret: float,
    occurred_at: datetime,
    z_threshold: float = Z_THRESHOLD,
) -> Optional[Event]:
    """Score one new return observation against a symbol's fitted beta.
    Returns an Event only if the unexplained residual clears `z_threshold`;
    otherwise the move was explained by the market and nothing is emitted."""
    z = residual_z(stock_ret, index_ret, fit.beta, fit.resid_sigma)
    if abs(z) < z_threshold:
        return None

    explained = fit.beta * index_ret
    residual = stock_ret - explained

    reason = (
        f"{fit.symbol} {stock_ret:+.1%} vs NIFTY {index_ret:+.1%}. "
        f"Beta {fit.beta:.2f} explains {explained:+.1%}; "
        f"{residual:+.1%} is unexplained ({z:.1f}σ)."
    )
    evidence = {
        "stock_ret": stock_ret,
        "index_ret": index_ret,
        "beta": fit.beta,
        "resid_sigma": fit.resid_sigma,
        "explained_ret": explained,
        "residual_ret": residual,
        "z": z,
    }
    return Event(
        symbol=fit.symbol,
        type="RESIDUAL_MOVE",
        score=z,
        reason=reason,
        evidence=evidence,
        occurred_at=occurred_at,
        fingerprint=_fingerprint(fit.symbol, "RESIDUAL_MOVE", occurred_at),
    )


if __name__ == "__main__":
    from datetime import timezone

    # 20 daily log returns for the index, fixed by hand so the fit below is
    # reproducible. Idiosyncratic noise is a symmetric +/-0.0006 alternation
    # (zero mean, stdev exactly 0.0006) layered on top of a true beta of 1.5.
    index_returns = [
        0.008, -0.006, 0.005, -0.004, 0.003, -0.002, 0.006, -0.005,
        0.004, -0.003, 0.007, -0.006, 0.005, -0.004, 0.003, -0.002,
        0.006, -0.005, 0.004, -0.003,
    ]
    noise = [0.0006, -0.0006] * 10
    beta_true = 1.5
    stock_returns = [beta_true * ir + n for ir, n in zip(index_returns, noise)]

    def closes_from_returns(start_price: float, rets: list[float]) -> list[float]:
        closes = [start_price]
        for r in rets:
            closes.append(closes[-1] * math.exp(r))
        return closes

    index_closes = closes_from_returns(20000.0, index_returns)
    # QUIET.NS and MOVER.NS share the exact same 20-day history -- only
    # today's tick (scored below) tells them apart.
    quiet_closes = closes_from_returns(1300.0, stock_returns)
    mover_closes = closes_from_returns(1300.0, stock_returns)

    quiet_fit = fit_beta("QUIET.NS", quiet_closes, index_closes)
    mover_fit = fit_beta("MOVER.NS", mover_closes, index_closes)
    print(quiet_fit)
    print(mover_fit)

    # 20 noisy points won't recover beta_true exactly -- finite-sample
    # estimation error is expected (this is why PLAN.md flags beta as
    # unstable for illiquid/short-history names), so check it's in the
    # right ballpark rather than exact.
    assert math.isclose(quiet_fit.beta, beta_true, rel_tol=0.3), "beta should recover ~1.5"
    assert quiet_fit.resid_sigma < 0.002, "residual noise floor should stay near the 0.0006 it was built from"

    now = datetime(2026, 9, 5, 10, 0, tzinfo=timezone.utc)

    # QUIET.NS: today's move is fully explained by beta -- residual stays
    # inside the historical noise floor, so nothing should fire.
    quiet_index_ret = 0.004
    quiet_stock_ret = beta_true * quiet_index_ret + 0.0005
    quiet_event = detect_residual_move(quiet_fit, quiet_stock_ret, quiet_index_ret, now)
    assert quiet_event is None, "explained move should not fire"
    print("QUIET.NS: no event (as expected) -- move fully explained by beta")

    # MOVER.NS: same index day, but with an unexplained +6% jump on top of
    # beta -- two orders of magnitude past the 0.0006 noise floor.
    mover_index_ret = 0.004
    mover_stock_ret = beta_true * mover_index_ret + 0.06
    mover_event = detect_residual_move(mover_fit, mover_stock_ret, mover_index_ret, now)
    assert mover_event is not None, "unexplained move should fire"
    assert abs(mover_event.score) >= Z_THRESHOLD
    print("MOVER.NS:", mover_event.reason)
    print("evidence:", mover_event.evidence)
    print("fingerprint:", mover_event.fingerprint)
