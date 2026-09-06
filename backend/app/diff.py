"""Net state diff for Signal -- the load-bearing gate.

detector.py answers "did something happen to this company" (the residual
gate). This module answers the harder question SPEC.md poses: "did it
survive to now" (the load-bearing gate). A Statement is derived by
diffing two StateVector snapshots, not by replaying the event log --
that's what gives `what_changed` its O(1)-in-absence-duration property:
diff_states only ever looks at two windows of trailing history, never at
how much calendar time separated them.

Pure functions, no DB, no I/O -- callers supply the trailing price/volume
history for each snapshot; nothing here fetches anything.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from typing import Optional, Sequence

import numpy as np

from .detector import Event, fit_beta, log_returns

DEFAULT_WINDOW = 20

VOL_REGIME_THRESHOLDS = (0.7, 1.4, 2.2)
VOL_REGIME_LABELS = ("quiet", "normal", "elevated", "high")
LIQ_REGIME_THRESHOLDS = (0.6, 1.3, 2.5)
LIQ_REGIME_LABELS = ("thin", "normal", "heavy", "surging")

BETA_CHANGE_THRESHOLD = 0.15
RANGE_POSITION_CHANGE_THRESHOLD = 0.5

FIELD_LABELS = {
    "volatility_regime": "volatility",
    "liquidity_regime": "liquidity",
    "beta_to_index": "market sensitivity (beta)",
    "range_position": "position in its recent range",
}

# Which state field(s) each detector.py event type could plausibly explain.
# Used by is_load_bearing: an event only counts as load-bearing if one of
# its mapped fields actually differs between the two snapshots.
EVENT_FIELD_MAP = {
    "RESIDUAL_MOVE": ("volatility_regime", "range_position"),
    "DELIVERY_CONVICTION": ("liquidity_regime",),
    "BLOCK_TRADE": ("liquidity_regime",),
}


@dataclass(frozen=True)
class StateVector:
    """The 8 fields from SPEC.md. Four are computed from price/volume
    history alone; four are left None with the reason documented here
    rather than faked, per SPEC.md's "state it, do not hide it" rule:

    - correlation_cluster_id: needs a peer universe to cluster against.
      This system snapshots one symbol at a time; nothing upstream of
      here builds cross-symbol correlation groups yet.
    - valuation_band: needs fundamentals (P/E, etc). sources.py only
      pulls price/volume from Yahoo's chart endpoint -- no fundamentals
      source is wired in (see README "What we cut").
    - surveillance_flag: NSE ASM/GSM surveillance measures aren't pulled
      yet either (same README section says so explicitly).
    - thesis_status: this is the user's own belief about *why* they hold
      a stock. It isn't derivable from price data at all -- it would
      need user-entered notes, which don't exist in this schema.
    """

    symbol: str
    as_of: date
    volatility_regime: Optional[str]
    liquidity_regime: Optional[str]
    beta_to_index: Optional[float]
    range_position: Optional[float]
    correlation_cluster_id: Optional[str] = None
    valuation_band: Optional[str] = None
    surveillance_flag: Optional[bool] = None
    thesis_status: Optional[str] = None


@dataclass(frozen=True)
class Statement:
    symbol: str
    field: str
    reason: str
    evidence: dict


def _bucket_ratio(ratio: float, thresholds: tuple, labels: tuple) -> str:
    lo, mid, hi = thresholds
    if ratio < lo:
        return labels[0]
    if ratio < mid:
        return labels[1]
    if ratio < hi:
        return labels[2]
    return labels[3]


def _volatility_regime(closes: Sequence[float], window: int) -> Optional[str]:
    """Trailing `window`-day return stdev vs the *adjacent* `window`
    days before it (not all of history) -- a rolling regime, so a shock
    that's rolled out of both windows stops affecting the reading at
    all, same as it stops affecting range_position. Needs 2 full
    windows of returns."""
    rets = log_returns(closes)
    if len(rets) < window * 2:
        return None
    baseline_sigma = float(np.std(rets[-window * 2 : -window]))
    recent_sigma = float(np.std(rets[-window:]))
    if baseline_sigma == 0:
        return None
    return _bucket_ratio(recent_sigma / baseline_sigma, VOL_REGIME_THRESHOLDS, VOL_REGIME_LABELS)


def _liquidity_regime(volumes: Sequence[float], window: int) -> Optional[str]:
    """Trailing `window`-day median volume vs the adjacent `window` days
    before it -- same rolling shape as _volatility_regime, on volume."""
    volumes = np.asarray(volumes, dtype=float)
    if len(volumes) < window * 2:
        return None
    baseline_med = float(np.median(volumes[-window * 2 : -window]))
    if baseline_med == 0:
        return None
    recent_med = float(np.median(volumes[-window:]))
    return _bucket_ratio(recent_med / baseline_med, LIQ_REGIME_THRESHOLDS, LIQ_REGIME_LABELS)


def _range_position(closes: Sequence[float], window: int) -> Optional[float]:
    """Where the latest close sits within its trailing `window`-day
    high-low band: 0 = at the low, 1 = at the high."""
    if len(closes) < window:
        return None
    tail = closes[-window:]
    lo, hi = min(tail), max(tail)
    if hi == lo:
        return 0.5
    return (closes[-1] - lo) / (hi - lo)


def _beta_to_index(symbol: str, closes: Sequence[float], index_closes: Sequence[float], window: int) -> Optional[float]:
    # fit_beta itself only requires >=2 closes and nonzero index variance
    # -- technically enough to return a number, but a beta fit on a
    # handful of points is noise wearing a number's clothes. Hold it to
    # the same window*2 bar as the regime fields so a thin-history
    # snapshot reports None everywhere instead of a confident-looking
    # beta next to two honest Nones.
    if len(closes) < window * 2 or len(index_closes) < window * 2:
        return None
    try:
        return fit_beta(symbol, closes, index_closes, window=window).beta
    except ValueError:
        # Same length mismatch or zero index variance -- fit_beta's own
        # documented failure modes, not silent zeros.
        return None


def snapshot_state(
    symbol: str,
    as_of: date,
    closes: Sequence[float],
    volumes: Sequence[float],
    index_closes: Sequence[float],
    window: int = DEFAULT_WINDOW,
) -> StateVector:
    """Compute the 4 data-derived StateVector fields from trailing
    history ending at `as_of`. Pure: takes the history as input, does
    not fetch it."""
    return StateVector(
        symbol=symbol,
        as_of=as_of,
        volatility_regime=_volatility_regime(closes, window),
        liquidity_regime=_liquidity_regime(volumes, window),
        beta_to_index=_beta_to_index(symbol, closes, index_closes, window),
        range_position=_range_position(closes, window),
    )


def diff_states(state_t0: StateVector, state_now: StateVector) -> list[Statement]:
    """The net state diff: what_changed(t0, now) = state(now) - state(t0).

    Compares fields directly, never the event log in between -- a field
    that went out and came back produces no statement, and the output
    size depends only on how many fields actually differ, never on how
    long the gap between t0 and now was.
    """
    if state_t0.symbol != state_now.symbol:
        raise ValueError("diff_states compares two snapshots of the same symbol")

    statements: list[Statement] = []

    for field in ("volatility_regime", "liquidity_regime"):
        before, after = getattr(state_t0, field), getattr(state_now, field)
        if before is None or after is None or before == after:
            continue
        statements.append(
            Statement(
                symbol=state_now.symbol,
                field=field,
                reason=f"{state_now.symbol}'s {FIELD_LABELS[field]} regime moved from {before} to {after}.",
                evidence={"from": before, "to": after},
            )
        )

    b0, b1 = state_t0.beta_to_index, state_now.beta_to_index
    if b0 is not None and b1 is not None and abs(b1 - b0) >= BETA_CHANGE_THRESHOLD:
        statements.append(
            Statement(
                symbol=state_now.symbol,
                field="beta_to_index",
                reason=f"{state_now.symbol}'s beta to the index shifted from {b0:.2f} to {b1:.2f}.",
                evidence={"from": b0, "to": b1},
            )
        )

    r0, r1 = state_t0.range_position, state_now.range_position
    if r0 is not None and r1 is not None and abs(r1 - r0) >= RANGE_POSITION_CHANGE_THRESHOLD:
        statements.append(
            Statement(
                symbol=state_now.symbol,
                field="range_position",
                reason=f"{state_now.symbol} moved from {r0:.0%} to {r1:.0%} of its recent range.",
                evidence={"from": r0, "to": r1},
            )
        )

    return statements


def is_load_bearing(event: Event, state_t0: StateVector, state_now: StateVector) -> bool:
    """An event is load-bearing iff removing it would change state(now).

    Operationalized: at least one state field this event's type could
    plausibly explain (EVENT_FIELD_MAP) actually differs between t0 and
    now. A residual move whose effect fully reverted by `now` -- support
    broken then recovered -- maps to fields that come back unchanged, so
    this correctly returns False for it: the event happened, but it
    isn't load-bearing.
    """
    fields = EVENT_FIELD_MAP.get(event.type, ())
    if not fields:
        return False
    changed_fields = {s.field for s in diff_states(state_t0, state_now)}
    return any(f in changed_fields for f in fields)


if __name__ == "__main__":
    from datetime import datetime, timezone
    import math

    def closes_from_returns(start_price: float, rets: list[float]) -> list[float]:
        closes = [start_price]
        for r in rets:
            closes.append(closes[-1] * math.exp(r))
        return closes

    # ---- Fixture 1: support broken in March, recovered in April ----
    # 40 quiet days, a 6-day dip, 6-day recovery, then 45 more quiet days
    # -- long enough that BOTH the recent and baseline 20-day windows
    # used by _volatility_regime are clear of the dip by "now", not just
    # the recent one.
    # A 4-value cycle (net zero) rather than a 2-value alternation -- a
    # pure +/-x alternation only ever visits 2 price levels, so its
    # trailing window's min/max IS the last close, making range_position
    # land at exactly 0 or 1 depending on nothing but parity. 4 distinct
    # levels give a real interior range instead.
    quiet_pair = [0.0006, -0.0003, -0.0006, 0.0003]
    quiet_40 = (quiet_pair * 20)[:40]
    dip = [-0.03, -0.02, -0.01, 0.0, 0.0, 0.0]        # break support
    recover = [0.01, 0.02, 0.03, 0.0, 0.0, 0.0]        # recover it
    # 44 (not just 20) so the quiet cycle has fully re-aligned to the same
    # phase it was at pre-dip by the time state_now looks at its own
    # trailing window -- otherwise range_position would show a phantom
    # move that's really just the toy cycle's own periodicity, not a
    # real regime change.
    post_quiet_20 = (quiet_pair * 11)[:44]

    rets_1 = quiet_40 + dip + recover + post_quiet_20
    closes_1 = closes_from_returns(100.0, rets_1)
    index_closes_1 = closes_from_returns(20000.0, [0.0] * len(rets_1))
    volumes_1 = [1_000_000.0] * (len(closes_1))

    # state_t0: snapshotted right before the dip (index 40 into closes).
    t0_closes = closes_1[: 41]
    t0_vols = volumes_1[: 41]
    t0_index = index_closes_1[: 41]
    state_t0 = snapshot_state("QUIET.NS", date(2026, 3, 1), t0_closes, t0_vols, t0_index)

    # state_now: snapshotted at the very end, dip and recovery both more
    # than 20 trading days in the past.
    state_now = snapshot_state("QUIET.NS", date(2026, 4, 15), closes_1, volumes_1, index_closes_1)

    statements = diff_states(state_t0, state_now)
    assert statements == [], f"support broken-then-recovered should yield 0 statements, got {statements}"
    print("fixture 1: support broken + recovered -> 0 statements (as expected)")

    dip_event = Event(
        symbol="QUIET.NS",
        type="RESIDUAL_MOVE",
        score=-3.2,
        reason="test fixture",
        evidence={},
        occurred_at=datetime(2026, 3, 5, tzinfo=timezone.utc),
        fingerprint="QUIET.NS|RESIDUAL_MOVE|test",
    )
    assert is_load_bearing(dip_event, state_t0, state_now) is False, "reverted event should not be load-bearing"
    print("fixture 1: the dip's own RESIDUAL_MOVE event is correctly not load-bearing")

    # ---- Fixture 2: 6 events, net +1.5%, volatility doubles ----
    # 40 quiet days (+/-0.001), then 20 louder days (+/-0.002) netting to
    # a small drift -- price ends up ~1.5% higher, range barely widens,
    # but the trailing-20-day return stdev roughly doubles.
    quiet_pair_2 = [0.001, -0.001]
    quiet_40_2 = (quiet_pair_2 * 20)[:40]
    loud_pair = [0.0021, -0.0019]  # net +0.0002/day -> ~+1.5% over ~60 obs region incl drift
    loud_20 = (loud_pair * 10)[:20]

    rets_2 = quiet_40_2 + loud_20
    closes_2 = closes_from_returns(100.0, rets_2)
    index_closes_2 = closes_from_returns(20000.0, [0.0] * len(rets_2))
    volumes_2 = [1_000_000.0] * len(closes_2)

    state_t0_2 = snapshot_state("MOVER.NS", date(2026, 1, 1), closes_2[:41], volumes_2[:41], index_closes_2[:41])
    state_now_2 = snapshot_state("MOVER.NS", date(2026, 2, 15), closes_2, volumes_2, index_closes_2)

    net_move = closes_2[-1] / closes_2[40] - 1
    statements_2 = diff_states(state_t0_2, state_now_2)
    fields_2 = {s.field for s in statements_2}
    assert fields_2 == {"volatility_regime"}, (
        f"expected exactly one statement, about volatility_regime; got fields={fields_2}, "
        f"net_move={net_move:.2%}, t0={state_t0_2}, now={state_now_2}"
    )
    print(f"fixture 2: net move {net_move:+.2%}, volatility doubled -> exactly 1 statement:")
    print(" ", statements_2[0].reason)

    # ---- Fixture 3: absence of 1 day vs 180 days -> flat statement count ----
    # snapshot_state is a pure function of its trailing window, indifferent
    # to `as_of` or to how much history came before it. So: give it the
    # exact same trailing window -- "whatever the market looks like
    # whenever the user comes back" -- once labelled 1 day after t0, once
    # labelled 180 days after t0. Same window in means same state out,
    # by construction; that's the whole reason len(S) can't grow with
    # the length of the gap.
    base_rets = quiet_pair * 20  # 40 quiet days, same fixture as #1's baseline
    base_closes = closes_from_returns(100.0, base_rets[:40])
    base_volumes = [1_000_000.0] * len(base_closes)
    base_index = closes_from_returns(20000.0, [0.0] * (len(base_closes) - 1))

    state_t0_3 = snapshot_state("FLAT.NS", date(2026, 5, 1), base_closes, base_volumes, base_index)
    same_window_closes = closes_from_returns(base_closes[-1], quiet_pair * 10)
    same_window_volumes = [1_000_000.0] * len(same_window_closes)
    same_window_index = closes_from_returns(20000.0, [0.0] * (len(same_window_closes) - 1))
    state_now_1day = snapshot_state("FLAT.NS", date(2026, 5, 2), same_window_closes, same_window_volumes, same_window_index)
    state_now_180day = snapshot_state("FLAT.NS", date(2026, 10, 28), same_window_closes, same_window_volumes, same_window_index)

    count_1day = len(diff_states(state_t0_3, state_now_1day))
    count_180day = len(diff_states(state_t0_3, state_now_180day))
    assert count_1day == count_180day, (
        f"statement count should stay flat regardless of absence duration, got 1day={count_1day} 180day={count_180day}"
    )
    print(f"fixture 3: 1-day absence -> {count_1day} statements, 180-day absence -> {count_180day} statements (flat)")

    print("\nall diff.py fixtures pass")
