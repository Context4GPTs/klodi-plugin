"""Python pre-call guard contract (RED).

Three guards run in fixed order before any NATS request issues:

  1. ``guard_creds`` — ``${klodi_home}/{nats.creds, config.json}`` both
     exist. Failure → ``not_registered`` + ``NextAction.cli``.
  2. ``guard_connection`` — the lazy NATS client is connected. Failure
     → ``connection_not_ready`` + ``NextAction.tool { klodi_setup_status }``.
  3. ``guard_args`` — adapter-side schema check on required fields.
     Failure → ``invalid_request`` + ``details: {field, problem}``,
     no recovery_hint (agent re-calls with corrected args).

Guards fail FAST — no NATS connection opened, no filesystem mutated,
no marketplace request issued. First failure short-circuits; later
guards do NOT execute (R4).

Production items the implementer must add to
``packages/nats-client-py/src/klodi_nats_client/guards.py``::

    from enum import Enum
    from pathlib import Path
    from typing import Any
    from collections.abc import Mapping, Sequence

    class ArgKind(str, Enum):
        UUID = "uuid"
        STRING = "string"
        INTEGER = "integer"
        BOOL = "bool"
        NON_EMPTY_STRING = "non_empty_string"

    def guard_creds(
        klodi_home: Path,
        register_cli: str,
    ) -> dict[str, Any] | None:
        ...  # None on pass; envelope on fail

    def guard_args(
        args: Mapping[str, Any],
        required: Sequence[tuple[str, ArgKind]],
    ) -> dict[str, Any] | None:
        ...

    def run_pre_call_guards(
        klodi_home: Path,
        register_cli: str,
        args: Mapping[str, Any],
        required: Sequence[tuple[str, ArgKind]],
    ) -> dict[str, Any] | None:
        ...  # composes creds → args; connection guard is async, lives
            # in the adapter-side dispatch wrapper.

This file is QA-owned during RED. NEVER weaken these asserts.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest

# The implementer adds these symbols. Until they exist, imports fail.
from klodi_nats_client.guards import (  # type: ignore[import-not-found]
    ArgKind,
    guard_args,
    guard_creds,
    run_pre_call_guards,
)


# ── guard_creds ───────────────────────────────────────────────────────


def test_guard_creds_returns_none_when_both_files_present(tmp_path: Path) -> None:
    (tmp_path / "nats.creds").write_text("fake-creds")
    (tmp_path / "config.json").write_text("{}")
    assert guard_creds(tmp_path, "klodi-hermes-register") is None


def test_guard_creds_rejects_when_creds_file_missing(tmp_path: Path) -> None:
    (tmp_path / "config.json").write_text("{}")
    env = guard_creds(tmp_path, "klodi-hermes-register")
    assert env is not None, "guard fails when nats.creds is absent"
    assert env["error"] == "not_registered"
    hint = env["recovery_hint"]
    assert hint is not None
    # R8 — recovery_hint references the host's register CLI verbatim
    # so the agent surfaces the exact command the operator runs.
    assert hint["kind"] == "cli"
    assert hint["command"] == "klodi-hermes-register"


def test_guard_creds_rejects_when_config_file_missing(tmp_path: Path) -> None:
    (tmp_path / "nats.creds").write_text("fake-creds")
    env = guard_creds(tmp_path, "klodi-nanobot-register")
    assert env is not None, "guard fails when config.json is absent"
    assert env["error"] == "not_registered"
    assert env["recovery_hint"]["command"] == "klodi-nanobot-register"


def test_guard_creds_rejects_when_both_files_missing(tmp_path: Path) -> None:
    """R4 — first guard fires; later guards do not run. The envelope
    reports ``not_registered`` regardless of how many files are missing."""
    env = guard_creds(tmp_path, "klodi-hermes-register")
    assert env is not None
    assert env["error"] == "not_registered"


def test_guard_creds_returns_full_envelope_with_four_keys(tmp_path: Path) -> None:
    env = guard_creds(tmp_path, "klodi-hermes-register")
    assert env is not None
    assert set(env.keys()) == {"error", "message", "details", "recovery_hint"}


# ── guard_args ────────────────────────────────────────────────────────


def test_guard_args_passes_well_formed_payload() -> None:
    args = {"transaction_id": "550e8400-e29b-41d4-a716-446655440000"}
    env = guard_args(args, [("transaction_id", ArgKind.UUID)])
    assert env is None, "well-formed args pass"


def test_guard_args_rejects_missing_required_field() -> None:
    """R2: error code is ``invalid_request``. details.field names the
    offending field; details.problem is ``"missing"``. No recovery_hint."""
    env = guard_args({}, [("transaction_id", ArgKind.UUID)])
    assert env is not None
    assert env["error"] == "invalid_request"
    details = env["details"]
    assert details is not None
    assert details["field"] == "transaction_id"
    assert details["problem"] == "missing"
    assert env["recovery_hint"] is None, (
        "invalid_request must NOT carry a recovery_hint (agent re-calls)"
    )


def test_guard_args_rejects_wrong_type_field() -> None:
    """A UUID field receiving an integer is ``problem=wrong_type``."""
    env = guard_args(
        {"transaction_id": 42}, [("transaction_id", ArgKind.UUID)]
    )
    assert env is not None
    assert env["error"] == "invalid_request"
    assert env["details"]["field"] == "transaction_id"
    assert env["details"]["problem"] == "wrong_type"


def test_guard_args_rejects_empty_string_field() -> None:
    env = guard_args({"content": ""}, [("content", ArgKind.NON_EMPTY_STRING)])
    assert env is not None
    assert env["error"] == "invalid_request"
    assert env["details"]["field"] == "content"
    assert env["details"]["problem"] == "empty"


def test_guard_args_rejects_malformed_uuid() -> None:
    env = guard_args(
        {"transaction_id": "not-a-uuid"}, [("transaction_id", ArgKind.UUID)]
    )
    assert env is not None
    assert env["error"] == "invalid_request"
    assert env["details"]["field"] == "transaction_id"
    assert env["details"]["problem"] == "wrong_type"


def test_guard_args_short_circuits_at_first_failure() -> None:
    """R4 first-failure short-circuit applies to args validation too.
    ``channel_id`` (first in the required list) is reported even when
    ``content`` is also bad."""
    env = guard_args(
        {"content": ""},
        [
            ("channel_id", ArgKind.UUID),
            ("content", ArgKind.NON_EMPTY_STRING),
        ],
    )
    assert env is not None
    assert env["details"]["field"] == "channel_id"
    assert env["details"]["problem"] == "missing"


def test_guard_args_passes_integer_when_expected() -> None:
    args = {"limit": 10}
    env = guard_args(args, [("limit", ArgKind.INTEGER)])
    assert env is None


def test_guard_args_rejects_boolean_passed_as_integer() -> None:
    """In Python, ``bool`` is a subclass of ``int``. The guard must NOT
    accept ``True`` where an integer is required — that would let an
    agent silently pass ``True`` as ``limit=1``."""
    args = {"limit": True}
    env = guard_args(args, [("limit", ArgKind.INTEGER)])
    assert env is not None
    assert env["error"] == "invalid_request"
    assert env["details"]["field"] == "limit"
    assert env["details"]["problem"] == "wrong_type"


# ── run_pre_call_guards (composition / ordering) ─────────────────────


def test_run_pre_call_guards_reports_creds_failure_before_args_failure(
    tmp_path: Path,
) -> None:
    """R4 guard ordering — creds-first. When creds AND args are both
    invalid, the envelope reports ``not_registered`` (not ``invalid_request``).
    """
    env = run_pre_call_guards(
        tmp_path,
        "klodi-hermes-register",
        {},  # also bad args
        [("transaction_id", ArgKind.UUID)],
    )
    assert env is not None
    assert env["error"] == "not_registered", (
        "creds guard must fire before args guard"
    )


def test_run_pre_call_guards_reaches_args_after_creds_pass(tmp_path: Path) -> None:
    (tmp_path / "nats.creds").write_text("fake")
    (tmp_path / "config.json").write_text("{}")
    env = run_pre_call_guards(
        tmp_path,
        "klodi-hermes-register",
        {},
        [("transaction_id", ArgKind.UUID)],
    )
    assert env is not None
    assert env["error"] == "invalid_request"


def test_run_pre_call_guards_returns_none_on_full_pass(tmp_path: Path) -> None:
    (tmp_path / "nats.creds").write_text("fake")
    (tmp_path / "config.json").write_text("{}")
    env = run_pre_call_guards(
        tmp_path,
        "klodi-hermes-register",
        {"transaction_id": "550e8400-e29b-41d4-a716-446655440000"},
        [("transaction_id", ArgKind.UUID)],
    )
    assert env is None


# ── Side-effect freedom (R4) ──────────────────────────────────────────


def test_guards_never_mutate_klodi_home(tmp_path: Path) -> None:
    """Guards never write to ``${KLODI_HOME}``. Verified by snapshotting
    the directory before and after the call."""
    before = sorted(p.name for p in tmp_path.iterdir())
    _ = run_pre_call_guards(
        tmp_path,
        "klodi-hermes-register",
        {},
        [("transaction_id", ArgKind.UUID)],
    )
    after = sorted(p.name for p in tmp_path.iterdir())
    assert before == after, "guards must not create files in KLODI_HOME"


def test_guards_returns_full_envelope_with_four_keys(tmp_path: Path) -> None:
    """Every rejection envelope from run_pre_call_guards carries the R1
    four-key shape."""
    env = run_pre_call_guards(
        tmp_path,
        "klodi-hermes-register",
        {},
        [("transaction_id", ArgKind.UUID)],
    )
    assert env is not None
    assert set(env.keys()) == {"error", "message", "details", "recovery_hint"}
