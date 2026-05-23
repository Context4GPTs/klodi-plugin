"""Cross-language tool-result envelope for the Python adapter pair.

The architect's ADR-0011 plan locks the wire format at::

    {"error": "<code>", "message": "<human>", "details": {...|None},
     "recovery_hint": {...|None}}

All four keys are ALWAYS present. ``details`` and ``recovery_hint``
serialise as JSON ``null`` (Python ``None``) when absent — never elided.
``recovery_hint`` mirrors the ``NextAction`` discriminated union from
``klodi-rust-host``:

    {"kind": "cli",    "command": str, "message": str}
    {"kind": "tool",   "tool":    str, "message": str}
    {"kind": "shell",  "shell":   str, "message": str}
    {"kind": "dialog", "path":    str, "message": str}

Cross-language parity: the Rust ``ToolEnvelope`` (in
``packages/klodi-rust-host/src/mcp/envelope.rs``) and the openclaw TS
envelope (in ``adapters/openclaw/src/lib/envelope.ts``) emit the same
four-key shape under matching conditions. The shared fixture at
``packages/tool-catalog/tests/fixtures/envelope-golden.json`` is the
cross-language oracle.

See ADR-0011.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from klodi_nats_client.client import KlodiRequestError
from klodi_nats_client.consumers import KlodiSetupError

__all__ = [
    "make_envelope",
    "envelope_from_klodi_request_error",
    "envelope_from_creds_not_found",
    "envelope_from_config_not_found",
    "envelope_from_not_connected",
    "envelope_from_setup_error",
    "envelope_from_unknown",
]


def make_envelope(
    *,
    error: str,
    message: str,
    details: Mapping[str, Any] | None = None,
    recovery_hint: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    """Build the canonical four-key envelope.

    Use ``details=None`` (the default) for envelopes without
    machine-readable cause; the serialiser emits JSON ``null`` rather
    than omitting the key (R1).
    """
    return {
        "error": error,
        "message": message,
        "details": dict(details) if details is not None else None,
        "recovery_hint": dict(recovery_hint) if recovery_hint is not None else None,
    }


def envelope_from_klodi_request_error(err: KlodiRequestError) -> dict[str, Any]:
    """Marketplace passthrough.

    Code and message are preserved verbatim; ``details`` is copied from
    the server envelope (or ``None`` when absent). ``recovery_hint``
    stays ``None`` per architect open Q2 — the adapter does NOT
    synthesise a hint for server-side codes.
    """
    details = err.details if err.details is not None else None
    return make_envelope(
        error=err.code,
        message=str(err),
        details=details if isinstance(details, Mapping) else None,
        recovery_hint=None,
    )


def envelope_from_creds_not_found(register_cli: str) -> dict[str, Any]:
    """``${KLODI_HOME}/nats.creds`` is missing.

    R8 — the recovery_hint references the host's register CLI verbatim
    so the agent surfaces the literal command the operator runs.
    """
    return _not_registered(register_cli)


def envelope_from_config_not_found(register_cli: str) -> dict[str, Any]:
    """``${KLODI_HOME}/config.json`` is missing.

    R4 — both halves of registration (nats.creds + config.json) collapse
    into one envelope so the agent's recovery logic does not branch on
    which file is absent.
    """
    return _not_registered(register_cli)


def envelope_from_not_connected() -> dict[str, Any]:
    """NATS-WS connection has not been established."""
    return make_envelope(
        error="connection_not_ready",
        message=(
            "klodi NATS connection is not ready. "
            "Call klodi_setup_status to diagnose, then retry."
        ),
        details=None,
        recovery_hint={
            "kind": "tool",
            "tool": "klodi_setup_status",
            "message": "Inspect setup state — connection is not ready.",
        },
    )


def envelope_from_setup_error(err: KlodiSetupError) -> dict[str, Any]:
    """``KlodiSetupError`` (consumer missing) → ``consumer_missing``.

    ``err.code`` is one of ``notifications_consumer_missing`` /
    ``channels_consumer_missing``; the consumer prefix is extracted into
    ``details.consumer`` so the agent can branch on which consumer is
    absent without re-parsing the code. Per the cross-language golden
    fixture, ``details`` carries ONLY the ``consumer`` key — no extras
    (the agent reads the consumer name, not the original error code).
    """
    consumer = err.code.removesuffix("_consumer_missing")
    return make_envelope(
        error="consumer_missing",
        message=str(err),
        details={"consumer": consumer},
        recovery_hint={
            "kind": "tool",
            "tool": "klodi_setup_status",
            "message": "Inspect setup state — a server-managed consumer is missing.",
        },
    )


def envelope_from_unknown(err: BaseException) -> dict[str, Any]:
    """Catch-all for uncategorised exceptions.

    Degrades to ``internal_error`` with no recovery_hint. The exception
    class name lands in ``details.exception_class`` so operators can
    triage; the agent retries once or surfaces to the operator.
    """
    return make_envelope(
        error="internal_error",
        message=str(err) or err.__class__.__name__,
        details={"exception_class": err.__class__.__name__},
        recovery_hint=None,
    )


def _not_registered(register_cli: str) -> dict[str, Any]:
    return make_envelope(
        error="not_registered",
        message=(
            f"klodi is not registered on this host. Run {register_cli} from a shell "
            "to mint nats.creds and config.json under ${KLODI_HOME}."
        ),
        details=None,
        recovery_hint={
            "kind": "cli",
            "command": register_cli,
            "message": (
                f"Run {register_cli} — opens a browser link, polls for completion, "
                "writes nats.creds + config.json."
            ),
        },
    )
