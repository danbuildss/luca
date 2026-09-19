"""
Luca Core plugin — bridges Hermes to the Luca Core API (Fastify, localhost:3000).

All endpoints are localhost-only. Auth is x-user-id header.
User ID is read from LUCA_USER_ID env var (set at Hermes startup).
"""

import os
import json
import urllib.request
import urllib.error
from typing import Any

_API_BASE = os.environ.get("LUCA_API_BASE", "http://127.0.0.1:3000")
_USER_ID = os.environ.get("LUCA_USER_ID", "")


def _get(path: str, params: dict[str, str] | None = None) -> Any:
    url = _API_BASE + path
    if params:
        qs = "&".join(f"{k}={urllib.parse.quote(str(v))}" for k, v in params.items() if v is not None)
        url += "?" + qs
    req = urllib.request.Request(url, headers={"x-user-id": _USER_ID})
    with urllib.request.urlopen(req, timeout=15) as resp:
        return json.loads(resp.read())


def _post(path: str, body: dict) -> Any:
    data = json.dumps(body).encode()
    req = urllib.request.Request(
        _API_BASE + path,
        data=data,
        headers={"Content-Type": "application/json", "x-user-id": _USER_ID},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=15) as resp:
        return json.loads(resp.read())


import urllib.parse  # noqa: E402 — kept after helpers to avoid circular at module load


def get_pnl_summary(period_days: int = 30) -> dict:
    """
    Return profit-and-loss summary for the principal.

    Args:
        period_days: Lookback window in days (7, 30, or 90). Default 30.

    Returns:
        dict with keys: period_days, pnl (revenue_usdc, expenses_usdc, gas_usdc,
        net_usdc, unknown_count), breakdown (label-level rows).
    """
    return _get("/books/summary", {"period": str(period_days)})


def get_recent_events(label: str | None = None, limit: int = 20) -> dict:
    """
    Return recent classified transactions for review.

    Args:
        label: Filter by classification label (revenue, expense, gas,
               internal_transfer, treasury, x402_income, x402_spend,
               refund, unknown). Omit for all.
        limit: Max events to return (1–200). Default 20.

    Returns:
        dict with key 'events' — list of transaction records.
    """
    params: dict[str, str] = {"limit": str(min(int(limit), 200))}
    if label:
        params["label"] = label
    return _get("/events", params)


def get_wallet_balances() -> dict:
    """
    Return the latest balance snapshot for all watched wallets.

    Returns:
        dict with key 'balances' — list of {wallet_address, wallet_label,
        asset, balance, snapshot_at}.
    """
    return _get("/balances")


def apply_correction(event_id: str, label: str, reason: str = "", counterparty_name: str = "") -> dict:
    """
    Correct the classification of a transaction.

    Args:
        event_id: UUID of the transaction to correct.
        label: New classification label. Must be one of: revenue, expense,
               gas, internal_transfer, treasury, x402_income, x402_spend,
               refund, unknown.
        reason: Optional explanation (stored for audit trail).
        counterparty_name: Optional human-readable counterparty label.

    Returns:
        dict with key 'ok': True on success.
    """
    body: dict = {"event_id": event_id, "label": label}
    if reason:
        body["reason"] = reason
    if counterparty_name:
        body["counterparty_name"] = counterparty_name
    return _post("/corrections", body)


def check_health() -> dict:
    """
    Check whether the Luca Core API and database are reachable.

    Returns:
        dict with keys: status ('ok' or 'degraded'), db, version.
    """
    return _get("/health")
