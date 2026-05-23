"""Pre-call guard contract for the Python adapter pair.

Three guards run in fixed order before any NATS request issues (R4):

  1. :func:`guard_creds` — ``${klodi_home}/{nats.creds, config.json}``
     both exist. Failure → ``not_registered`` envelope with the
     ``NextAction.cli`` recovery hint.
  2. :func:`guard_connection` (adapter-side, async) — the lazy
     ``KlodiClient`` is connected. Failure → ``connection_not_ready``
     envelope with the ``NextAction.tool { klodi_setup_status }``
     recovery hint. Lives in the adapter dispatch wrapper because
     ``KlodiClient.connect`` is async.
  3. :func:`guard_args` — adapter-side schema check on required fields.
     Failure → ``invalid_request`` + ``details: {field, problem}``;
     no recovery_hint (agent re-calls with corrected args).

Guards fail FAST — no NATS connection opened, no filesystem mutated,
no marketplace request issued. First failure short-circuits; later
guards do NOT execute.

The Rust pair lives at
``packages/klodi-rust-host/src/mcp/guards.rs``; both modules emit the
same envelope shape under matching conditions.

See ADR-0011.
"""

from __future__ import annotations

import re
from collections.abc import Mapping, Sequence
from enum import Enum
from pathlib import Path
from typing import Any

from klodi_nats_client.envelope import envelope_from_creds_not_found, make_envelope

__all__ = ["ArgKind", "guard_creds", "guard_args", "run_pre_call_guards"]


class ArgKind(str, Enum):
    """Argument-shape vocabulary. Widen only when a new catalog tool
    needs a new type — keep the surface minimal.
    """

    UUID = "uuid"
    STRING = "string"
    INTEGER = "integer"
    BOOL = "bool"
    NON_EMPTY_STRING = "non_empty_string"


# UUID-v4 pattern shared with the catalog schemas. The hand-rolled match
# avoids importing a separate regex engine for one well-known pattern.
_UUID_V4_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
)


def guard_creds(klodi_home: Path, register_cli: str) -> dict[str, Any] | None:
    """Return ``None`` when both creds + config files exist; otherwise a
    ``not_registered`` envelope. The envelope's ``recovery_hint`` carries
    the host-specific ``register_cli`` so the agent surfaces the literal
    command the operator runs (R8).
    """
    creds_present = (klodi_home / "nats.creds").is_file()
    config_present = (klodi_home / "config.json").is_file()
    if creds_present and config_present:
        return None
    return envelope_from_creds_not_found(register_cli)


def guard_args(
    args: Mapping[str, Any],
    required: Sequence[tuple[str, ArgKind]],
) -> dict[str, Any] | None:
    """Walk ``required`` in order and return the FIRST envelope describing
    a missing / wrong-type / empty field. R4 short-circuit: the agent
    sees one problem at a time and fixes them in catalog order.
    """
    for field, kind in required:
        if field not in args or args[field] is None:
            return _invalid_request(field, "missing")
        problem = _check_value(args[field], kind)
        if problem is not None:
            return _invalid_request(field, problem)
    return None


def run_pre_call_guards(
    klodi_home: Path,
    register_cli: str,
    args: Mapping[str, Any],
    required: Sequence[tuple[str, ArgKind]],
) -> dict[str, Any] | None:
    """Synchronous pre-call guard composition: creds → args.

    ``guard_connection`` is async and depends on the per-adapter client
    handle, so it composes in the adapter-side dispatch wrapper (not
    here). This helper covers the test path and any future synchronous
    caller.
    """
    creds_env = guard_creds(klodi_home, register_cli)
    if creds_env is not None:
        return creds_env
    return guard_args(args, required)


def _invalid_request(field: str, problem: str) -> dict[str, Any]:
    return make_envelope(
        error="invalid_request",
        message=f"argument `{field}` is {problem}; re-call with a corrected value",
        details={"field": field, "problem": problem},
        recovery_hint=None,
    )


def _check_value(value: Any, kind: ArgKind) -> str | None:
    if kind is ArgKind.UUID:
        if not isinstance(value, str):
            return "wrong_type"
        if value == "":
            return "empty"
        if not _UUID_V4_RE.match(value):
            return "wrong_type"
        return None
    if kind is ArgKind.STRING:
        if not isinstance(value, str):
            return "wrong_type"
        return None
    if kind is ArgKind.NON_EMPTY_STRING:
        if not isinstance(value, str):
            return "wrong_type"
        if value == "":
            return "empty"
        return None
    if kind is ArgKind.INTEGER:
        # bool is a subclass of int in Python; reject explicitly so an
        # agent does not silently pass ``True`` where ``limit=1`` is
        # expected.
        if isinstance(value, bool) or not isinstance(value, int):
            return "wrong_type"
        return None
    if kind is ArgKind.BOOL:
        if not isinstance(value, bool):
            return "wrong_type"
        return None
    return "wrong_type"
