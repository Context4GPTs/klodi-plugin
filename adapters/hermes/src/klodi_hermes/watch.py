"""klodi_watch / klodi_unwatch — server-side standing searches.

Per 0012, persistent watches no longer use a host-specific cron
primitive. The marketplace owns the search registry and pushes
``search.match`` events through the same JetStream notifications
consumer that delivers every other wake.

Adapter-side responsibilities:

* ``klodi_watch(persist=False)`` — one-shot search via
  ``p2p.v1.listings.search``.
* ``klodi_watch(persist=True)``  — call ``p2p.v1.searches.create`` AND
  write a ``buy/<slug>.md`` template under ``${KLODI_HOME}`` for the
  agent's private criteria + action policy.
* ``klodi_unwatch(slug)``        — call ``p2p.v1.searches.delete`` AND
  delete the local ``buy/<slug>.md`` file.

No cron. No ``cron_id``. No ``tools.cronjob_tools`` import. No
reconciliation loop.
"""

from __future__ import annotations

import json
import logging
import os
import re
from pathlib import Path
from typing import Any

from klodi_nats_client import KlodiRequestError

from .client import get_client, run_async
from .local_tools import _klodi_home

log = logging.getLogger("klodi_hermes.watch")


_SLUG_PATTERN = re.compile(r"^[a-z0-9][a-z0-9._-]*$")
_SLUG_MAX_LENGTH = 120
_VALID_ACTIONS = ("notify", "negotiate")
_DEFAULT_ACTION = "notify"


# ── Path helpers ─────────────────────────────────────────────────────


def _buy_dir() -> Path:
    return _klodi_home() / "buy"


def _buy_path(slug: str) -> Path:
    return _buy_dir() / f"{slug}.md"


def _ensure_buy_dir() -> None:
    path = _buy_dir()
    path.mkdir(parents=True, exist_ok=True)
    try:
        os.chmod(path, 0o700)
    except OSError:
        pass


# ── Slug + criteria helpers ──────────────────────────────────────────


def _validate_slug(slug: str) -> str:
    if not isinstance(slug, str) or not slug:
        raise ValueError("slug must be a non-empty string")
    if len(slug) > _SLUG_MAX_LENGTH:
        raise ValueError(f"slug must be at most {_SLUG_MAX_LENGTH} chars")
    if not _SLUG_PATTERN.fullmatch(slug):
        raise ValueError(
            "slug must match [a-z0-9][a-z0-9._-]* — lowercase"
            " alphanumerics plus '.', '_', '-'"
        )
    return slug


def _build_criteria(args: dict[str, Any]) -> dict[str, Any]:
    """Pull the public search params out of ``args``.

    Mirrors the catalog's ``klodi_search`` shape so server-side
    matching uses the same code path as one-shot searches. ``delivery``
    is a discriminated union (one of pickup, ship, digital, any) — the
    catalog's TypeBox schema is the authoritative validator.
    """
    criteria: dict[str, Any] = {}
    for key in ("query", "category", "min_price", "max_price", "limit"):
        value = args.get(key)
        if value is not None:
            criteria[key] = value
    delivery = args.get("delivery")
    if isinstance(delivery, dict):
        criteria["delivery"] = delivery
    return criteria


# ── Buy file template ────────────────────────────────────────────────


def _buy_file_template(
    slug: str,
    criteria: dict[str, Any],
    action: str,
    target_price: int | None,
) -> str:
    """Self-contained playbook the agent reads on a ``search.match``.

    Private criteria (brand, condition floor, walk-away price,
    negotiation posture) live below the SEED block — the user
    customizes them after watch creation. The marketplace never sees
    this file.
    """
    target_block = (
        f"target_price: {target_price}\n"
        if isinstance(target_price, int)
        else ""
    )
    public = json.dumps(criteria, indent=2)
    return (
        f"# klodi buy/{slug}\n\n"
        "Persistent buy-watch managed by the marketplace.\n"
        f"Action on match: **{action}**\n"
        f"{target_block}"
        "\n## Public criteria (sent to server)\n\n"
        f"```json\n{public}\n```\n\n"
        "## Private evaluation (never leaves this machine)\n\n"
        "<!-- SEED: replace this block with brand preferences,\n"
        "     condition floor, seller-rating threshold, walk-away\n"
        "     price, negotiation posture. The agent reads these on\n"
        "     every search.match wake before deciding to act. -->\n"
        "- brand: \n"
        "- condition_floor: \n"
        "- seller_rating_min: \n"
        "- walk_away_price: \n"
        "- negotiation_posture: \n"
    )


# ── Tool handlers ────────────────────────────────────────────────────


def handle_watch(args: dict[str, Any], **_kwargs: Any) -> str:
    persist = bool(args.get("persist", False))
    criteria = _build_criteria(args)

    if not persist:
        # One-shot search — round-trips to p2p.v1.listings.search.
        try:
            result = run_async(
                get_client().request("p2p.v1.listings.search", criteria)
            )
        except KlodiRequestError as err:
            return json.dumps({
                "error": err.code or "request_failed",
                "message": str(err),
            })
        except BaseException as err:  # noqa: BLE001 — boundary
            return json.dumps({
                "error": "transport_error",
                "message": str(err),
            })
        return json.dumps(result)

    # Persistent path — register server-side and template the buy file.
    slug_raw = args.get("slug")
    if not isinstance(slug_raw, str):
        return json.dumps({
            "error": "INVALID_REQUEST",
            "message": (
                "persist=True requires a `slug` (lowercase, [a-z0-9._-])."
            ),
        })
    try:
        slug = _validate_slug(slug_raw)
    except ValueError as err:
        return json.dumps({"error": "INVALID_SLUG", "message": str(err)})

    action = args.get("action_on_match") or _DEFAULT_ACTION
    if action not in _VALID_ACTIONS:
        return json.dumps({
            "error": "INVALID_ACTION",
            "message": f"action_on_match must be one of {_VALID_ACTIONS}",
        })
    target_price = args.get("target_price")
    if target_price is not None and not isinstance(target_price, int):
        return json.dumps({
            "error": "INVALID_TARGET_PRICE",
            "message": "target_price must be integer cents",
        })

    try:
        run_async(
            get_client().request(
                "p2p.v1.searches.create",
                {"slug": slug, **criteria},
            )
        )
    except KlodiRequestError as err:
        return json.dumps({
            "error": err.code or "request_failed",
            "message": str(err),
        })
    except BaseException as err:  # noqa: BLE001 — boundary
        return json.dumps({
            "error": "transport_error",
            "message": str(err),
        })

    try:
        _ensure_buy_dir()
        _buy_path(slug).write_text(
            _buy_file_template(slug, criteria, action, target_price),
            encoding="utf-8",
        )
    except OSError as err:
        # Server already has the search; surface the file write failure
        # so the user can fix the FS issue and rerun the buy-file
        # creation with klodi_watch persist=True (idempotent).
        log.warning(
            "watch_buy_file_write_failed slug=%s error=%s",
            slug,
            err,
        )
        return json.dumps({
            "error": "BUY_FILE_WRITE_FAILED",
            "message": str(err),
            "slug": slug,
            "watch_registered": True,
        })

    log.info("watch_created slug=%s action=%s", slug, action)
    return json.dumps({
        "slug": slug,
        "action_on_match": action,
        "criteria": criteria,
        "buy_file": str(_buy_path(slug)),
        "message": (
            f"Standing search '{slug}' registered. Match wakes will"
            " arrive via the notifications consumer with the listing"
            " summary in hand. Edit the buy file below to set private"
            " evaluation criteria before the agent acts."
        ),
    })


def handle_unwatch(args: dict[str, Any], **_kwargs: Any) -> str:
    slug_raw = args.get("slug")
    if not isinstance(slug_raw, str):
        return json.dumps({
            "error": "INVALID_REQUEST",
            "message": "slug is required (string)",
        })
    try:
        slug = _validate_slug(slug_raw)
    except ValueError as err:
        return json.dumps({"error": "INVALID_SLUG", "message": str(err)})

    try:
        run_async(
            get_client().request(
                "p2p.v1.searches.delete",
                {"slug": slug},
            )
        )
    except KlodiRequestError as err:
        # If the server says NOT_FOUND, the buy file may still exist —
        # delete it so the local + server states converge.
        log.info(
            "unwatch_server_response slug=%s code=%s",
            slug,
            err.code,
        )

    deleted_local = False
    try:
        _buy_path(slug).unlink()
        deleted_local = True
    except FileNotFoundError:
        pass
    except OSError as err:
        return json.dumps({
            "error": "BUY_FILE_DELETE_FAILED",
            "message": str(err),
            "slug": slug,
        })

    log.info("watch_removed slug=%s deleted_local=%s", slug, deleted_local)
    return json.dumps({
        "slug": slug,
        "removed": True,
        "buy_file_deleted": deleted_local,
    })


# ── Registration ─────────────────────────────────────────────────────


_DELIVERY_FILTER_SCHEMA: dict[str, Any] = {
    "description": (
        "Discriminated buyer delivery preference. Pick the variant matching"
        " the user's intent — fields from one variant cannot appear on"
        " another. Defaults to { method: 'any' } when omitted."
    ),
    "oneOf": [
        {
            "type": "object",
            "properties": {
                "method": {"const": "pickup"},
                "radiusKm": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": 1000,
                },
            },
            "required": ["method"],
            "additionalProperties": False,
        },
        {
            "type": "object",
            "properties": {
                "method": {"const": "ship"},
                "to": {
                    "type": "string",
                    "pattern": "^[A-Z]{2}(-[A-Z0-9]{1,5})?$",
                },
            },
            "required": ["method"],
            "additionalProperties": False,
        },
        {
            "type": "object",
            "properties": {"method": {"const": "digital"}},
            "required": ["method"],
            "additionalProperties": False,
        },
        {
            "type": "object",
            "properties": {"method": {"const": "any"}},
            "required": ["method"],
            "additionalProperties": False,
        },
    ],
}


_WATCH_PARAMS: dict[str, Any] = {
    "type": "object",
    "properties": {
        "query": {"type": "string"},
        "category": {
            "type": "string",
            "enum": [
                "electronics", "furniture", "vehicles", "clothing",
                "home_garden", "sports", "collectibles",
                "digital_goods", "services", "free", "other",
            ],
        },
        "min_price": {
            "type": "integer",
            "minimum": 0,
            "description": "Integer cents floor (1500 = $15)",
        },
        "max_price": {
            "type": "integer",
            "minimum": 0,
            "description": "Integer cents ceiling",
        },
        "delivery": _DELIVERY_FILTER_SCHEMA,
        "limit": {"type": "integer"},
        "slug": {
            "type": "string",
            "description": (
                "Required when persist=True. Lowercase identifier"
                " ([a-z0-9._-]) — names the buy/<slug>.md file and"
                " the server-side standing search."
            ),
        },
        "persist": {
            "type": "boolean",
            "description": (
                "True → register a server-side standing search and"
                " template a buy/<slug>.md file. False → one-shot"
                " search, return results."
            ),
            "default": False,
        },
        "action_on_match": {
            "type": "string",
            "enum": list(_VALID_ACTIONS),
            "description": (
                "notify: ping the user. negotiate: open a channel"
                " and negotiate within policy."
            ),
            "default": _DEFAULT_ACTION,
        },
        "target_price": {
            "type": "integer",
            "minimum": 0,
            "description": (
                "Opening offer in cents when action_on_match='negotiate'."
            ),
        },
    },
    "additionalProperties": False,
}


def register_watch_tools(ctx: Any, check_fn: Any | None) -> int:
    """Register klodi_watch + klodi_unwatch on the Hermes tool surface.

    Returns the number of tools registered.
    """
    ctx.register_tool(
        name="klodi_watch",
        toolset="klodi",
        schema={
            "name": "klodi_watch",
            "description": (
                "Search marketplace listings. With persist=False"
                " (default) returns current results. With persist=True"
                " registers a server-side standing search and templates"
                " a buy/<slug>.md file under KLODI_HOME for private"
                " evaluation criteria. The marketplace pushes"
                " search.match wakes through the notifications consumer"
                " — no cron, no host-specific timer."
            ),
            "parameters": _WATCH_PARAMS,
        },
        handler=handle_watch,
        check_fn=check_fn,
        requires_env=[],
        is_async=False,
        description="Search and optionally save a standing watch.",
        emoji="👁️",
    )
    ctx.register_tool(
        name="klodi_unwatch",
        toolset="klodi",
        schema={
            "name": "klodi_unwatch",
            "description": (
                "Delete a standing watch by slug. Removes the"
                " server-side registration and the local"
                " buy/<slug>.md file."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "slug": {
                        "type": "string",
                        "description": "slug of the watch to remove",
                    },
                },
                "required": ["slug"],
                "additionalProperties": False,
            },
        },
        handler=handle_unwatch,
        check_fn=check_fn,
        requires_env=[],
        is_async=False,
        description="Remove a standing watch.",
        emoji="✖️",
    )
    return 2


__all__ = [
    "handle_unwatch",
    "handle_watch",
    "register_watch_tools",
]
