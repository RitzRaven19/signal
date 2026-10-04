"""AI explainer for beginners: Google Gemini's free tier.

The browser sends what the user is pointing at plus the text on screen
around it; we add a fixed instruction and ask Gemini for a short,
plain-words explanation in the mascot's voice. The key stays on the
server (GEMINI_API_KEY); nothing about the user's identity is sent.

Free-tier notes (checked Oct 2026): Google may use free-tier content to
improve its products -- the UI says so -- and requests are rate-limited,
so we cap our own use (per visitor and per day) and cache repeat asks.
"""

from __future__ import annotations

import hashlib
import os
import time
from collections import defaultdict, deque

import httpx

GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
DEFAULT_MODEL = "gemini-3.8-flash"  # 2.5 models are closed to new accounts (Oct 2026)
FALLBACK_MODEL = "gemini-3.5-flash"
TIMEOUT = 40  # free-tier answers measured at 8-20s
MAX_CONTEXT_CHARS = 1800
MAX_TURNS = 8
MAX_QUESTION_CHARS = 400
PER_VISITOR_LIMIT = 20  # requests per window
PER_VISITOR_WINDOW = 600  # seconds
DAILY_LIMIT = int(os.environ.get("AI_DAILY_LIMIT", "400"))
CACHE_SECONDS = 600

SYSTEM = """You are Signal's mascot: a warm, upbeat anime girl who helps total beginners understand the Indian stock market inside the Signal app. Write in her voice: casual, kind, lowercase, at most one emoji.

Rules:
- Explain and describe only. Never tell the user to buy, sell or hold anything, never rank stocks as good or bad picks, and never predict prices. If asked for advice, say kindly that you can't give it and explain the concept instead.
- Use the on-screen text you are given for real numbers. If a number isn't there, say you can't see it rather than guessing.
- Assume zero prior knowledge: no jargon without explaining it, and give a tiny everyday example when it helps.
- Keep answers under 90 words unless the user asks for more.
- Everything in the app's shop is pretend money; real trades happen in the user's own broker app.
- If the question isn't about money, markets or the app, gently steer back."""


class AIUnavailable(RuntimeError):
    """Not configured, over a limit, or Gemini failed -- message is user-facing."""


_visitor_hits: dict[str, deque] = defaultdict(deque)
_day = {"date": None, "count": 0}
_cache: dict[str, tuple[float, str]] = {}


def _check_limits(visitor: str) -> None:
    now = time.time()
    hits = _visitor_hits[visitor]
    while hits and now - hits[0] > PER_VISITOR_WINDOW:
        hits.popleft()
    if len(hits) >= PER_VISITOR_LIMIT:
        raise AIUnavailable("you've asked a lot in a few minutes! give me a little break and try again soon 💗")
    today = time.strftime("%Y-%m-%d")
    if _day["date"] != today:
        _day.update(date=today, count=0)
    if _day["count"] >= DAILY_LIMIT:
        raise AIUnavailable("i've answered so many questions today that my free AI is tired. the regular explanations still work!")
    hits.append(now)
    _day["count"] += 1


def explain(*, visitor: str, title: str, about: str, context: str, history: list[dict], question: str) -> str:
    key = os.environ.get("GEMINI_API_KEY", "").strip()
    if not key:
        raise AIUnavailable("the AI helper isn't switched on yet, so i'm using my built-in explanations for now.")

    question = (question or f"explain '{title}' to me simply, using what's on my screen.").strip()[:MAX_QUESTION_CHARS]
    context = (context or "").strip()[:MAX_CONTEXT_CHARS]
    history = [h for h in history if h.get("role") in ("user", "model") and h.get("text")][-MAX_TURNS:]

    cache_key = None
    if not history:  # only first questions repeat often enough to cache
        cache_key = hashlib.sha256(f"{title}\n{context}\n{question}".encode()).hexdigest()
        hit = _cache.get(cache_key)
        if hit and time.time() - hit[0] < CACHE_SECONDS:
            return hit[1]

    _check_limits(visitor)

    grounding = (
        f"The user is pointing at: {title}\n"
        f"Built-in description: {about}\n"
        f"On-screen text around it:\n{context or '(none)'}"
    )
    # Turns must alternate user/model. The first user turn is the grounding
    # plus the opening question; the browser's history starts with the
    # model's first answer, then alternates.
    opening = f"explain '{title}' to me simply, using what's on my screen."
    if not history:
        contents = [{"role": "user", "parts": [{"text": f"{grounding}\n\n{question}"}]}]
    else:
        contents = [{"role": "user", "parts": [{"text": f"{grounding}\n\n{opening}"}]}]
        expected = "model"
        for h in history:
            if h["role"] != expected:
                continue  # drop anything that would break alternation
            contents.append({"role": h["role"], "parts": [{"text": str(h["text"])[:1200]}]})
            expected = "user" if expected == "model" else "model"
        if contents[-1]["role"] == "user":
            contents.pop()  # the newest user turn is `question` below
        contents.append({"role": "user", "parts": [{"text": question}]})

    model = os.environ.get("GEMINI_MODEL", DEFAULT_MODEL).strip() or DEFAULT_MODEL
    config: dict = {"maxOutputTokens": 400, "temperature": 0.6}
    # Without this, thinking used up the output budget and answers came back
    # cut off ("Hello" + MAX_TOKENS); short explainers don't need it.
    config["thinkingConfig"] = {"thinkingBudget": 0}
    body = {"systemInstruction": {"parts": [{"text": SYSTEM}]}, "contents": contents, "generationConfig": config}

    # Free-tier models get overloaded now and then (503 "high demand", seen
    # Oct 2026); try a second free model once before giving up.
    r = None
    for m in dict.fromkeys([model, FALLBACK_MODEL]):
        try:
            r = httpx.post(GEMINI_URL.format(model=m), headers={"x-goog-api-key": key}, json=body, timeout=TIMEOUT)
        except httpx.HTTPError:
            continue
        if r.status_code not in (429, 500, 503):
            break
    if r is None:
        raise AIUnavailable("i couldn't reach the AI just now. try again in a moment?")
    if r.status_code in (429, 500, 503):
        raise AIUnavailable("the free AI is busy right now. try again in a minute!")
    if r.status_code >= 400:
        raise AIUnavailable("the AI had a hiccup, so here's my built-in explanation instead.")

    data = r.json()
    cand = (data.get("candidates") or [{}])[0]
    text = "".join(p.get("text", "") for p in (cand.get("content") or {}).get("parts", [])).strip()
    if not text:
        raise AIUnavailable("i couldn't come up with an answer to that one. try asking another way?")
    if cache_key:
        _cache[cache_key] = (time.time(), text)
    return text
