"""Adversarial unit tests for `klodi_logger` (Cluster IV — Unified KlodiLogger).

These tests treat the public surface as the contract; the implementation
is the servant. They verify NDJSON shape, level filtering, redaction
behavior, child-scope inheritance, and structured error capture per
``docs/reviews/2026-04-26-klodi-plugin-multi-lens-review-decisions.md``
§ D15.
"""

from __future__ import annotations

import io
import json
import re

from klodi_logger import KlodiLogger, level_from_env, redact_fields


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def make_logger(level="INFO", base_fields=None):
    """Return a logger wired to in-memory stdout/stderr buffers."""
    out = io.StringIO()
    err = io.StringIO()
    log = KlodiLogger(
        "test",
        level=level,
        stdout=out,
        stderr=err,
        base_fields=base_fields,
    )
    return log, out, err


def parse_lines(buf: io.StringIO) -> list[dict]:
    text = buf.getvalue()
    return [json.loads(line) for line in text.splitlines() if line.strip()]


# ---------------------------------------------------------------------------
# level_from_env
# ---------------------------------------------------------------------------


def test_level_from_env_empty():
    assert level_from_env({}) == "INFO"


def test_level_from_env_lowercase():
    assert level_from_env({"LOG_LEVEL": "debug"}) == "DEBUG"


def test_level_from_env_unrecognised():
    assert level_from_env({"LOG_LEVEL": "trace"}) == "INFO"


# ---------------------------------------------------------------------------
# redact_fields
# ---------------------------------------------------------------------------


def test_redact_top_level():
    result = redact_fields(
        {
            "tool_name": "k",
            "bio": "x",
            "email": "y",
            "bearer_token": "z",
        }
    )
    assert result["tool_name"] == "k"
    assert result["bio"] == "[redacted]"
    assert result["email"] == "[redacted]"
    assert result["bearer_token"] == "[redacted]"


def test_redact_nested():
    result = redact_fields({"outer": {"inner": {"email": "x", "retain": 1}}})
    assert result["outer"]["inner"]["email"] == "[redacted]"
    assert result["outer"]["inner"]["retain"] == 1


def test_redact_lists():
    result = redact_fields([{"content": "a"}, {"content": "b"}])
    assert result == [{"content": "[redacted]"}, {"content": "[redacted]"}]


def test_redact_primitives():
    assert redact_fields("hello") == "hello"
    assert redact_fields(42) == 42
    assert redact_fields(None) is None


# ---------------------------------------------------------------------------
# NDJSON shape, redaction at emit time, level filtering
# ---------------------------------------------------------------------------


def test_info_emits_ndjson_shape():
    log, out, err = make_logger()
    log.info("event_invoked", {"user_id": "u-1"})

    lines = parse_lines(out)
    assert err.getvalue() == ""
    assert len(lines) == 1

    line = lines[0]
    assert isinstance(line["ts"], str)
    assert line["level"] == "INFO"
    assert line["scope"] == "test"
    assert line["msg"] == "event_invoked"
    assert line["fields"] == {"user_id": "u-1"}
    assert "error" not in line


def test_info_redacts_payload():
    log, out, _ = make_logger()
    log.info("wake", {"event_id": "e-1", "payload": {"body": "secret"}})

    [line] = parse_lines(out)
    assert line["fields"]["event_id"] == "e-1"
    assert line["fields"]["payload"] == "[redacted]"


def test_debug_does_not_redact():
    log, out, _ = make_logger(level="DEBUG")
    log.debug("wake", {"event_id": "e-1", "payload": {"body": "secret"}})

    [line] = parse_lines(out)
    assert line["fields"] == {
        "event_id": "e-1",
        "payload": {"body": "secret"},
    }


def test_level_filtering():
    log, out, err = make_logger(level="WARN")
    log.debug("d", {"k": 1})
    log.info("i", {"k": 1})
    log.warn("w", {"k": 1})
    log.error("e", {"k": 1})

    assert parse_lines(out) == []
    err_lines = parse_lines(err)
    assert len(err_lines) == 2
    assert err_lines[0]["level"] == "WARN"
    assert err_lines[1]["level"] == "ERROR"


# ---------------------------------------------------------------------------
# Error capture — top frame only, no full traceback leak
# ---------------------------------------------------------------------------


def _raise_boom() -> BaseException:
    """Raise then catch a ValueError so callers get a real traceback."""
    try:
        raise ValueError("boom")
    except ValueError as caught:
        return caught


def test_error_top_frame_only():
    log, _, err = make_logger()
    raised = _raise_boom()
    log.error("oops", {"event_id": "e-1"}, err=raised)

    raw = err.getvalue()
    # Exactly one trailing newline; no embedded literal newlines in the JSON.
    assert raw.endswith("\n")
    assert raw.count("\n") == 1
    # Defensive: the literal escape sequence \n must not appear inside the
    # serialised JSON either — that would mean a multi-line stack leaked
    # through json.dumps.
    assert "\\n" not in raw

    [line] = parse_lines(err)
    assert line["level"] == "ERROR"
    assert line["msg"] == "oops"
    assert line["fields"]["event_id"] == "e-1"

    error = line["error"]
    assert error["name"] == "ValueError"
    assert error["message"] == "boom"
    assert re.match(r"^at ", error["top_frame"]) is not None


# ---------------------------------------------------------------------------
# Child scope inheritance
# ---------------------------------------------------------------------------


def test_child_inherits_scope_level_fields():
    out = io.StringIO()
    err = io.StringIO()
    parent = KlodiLogger(
        "klodi-hermes",
        level="INFO",
        stdout=out,
        stderr=err,
        base_fields={"user_id": "u-1"},
    )
    child = parent.child("wake-handler", base_fields={"kind": "offer.proposed"})
    child.info("invoked", {"latency_ms": 12})

    [line] = parse_lines(out)
    assert line["scope"] == "klodi-hermes.wake-handler"
    assert line["fields"] == {
        "user_id": "u-1",
        "kind": "offer.proposed",
        "latency_ms": 12,
    }


# ---------------------------------------------------------------------------
# Output routing — INFO/DEBUG -> stdout, WARN/ERROR -> stderr
# ---------------------------------------------------------------------------


def test_output_routing():
    log, out, err = make_logger(level="DEBUG")
    log.debug("d", {"k": 1})
    log.info("i", {"k": 1})
    log.warn("w", {"k": 1})
    log.error("e", {"k": 1})

    out_lines = parse_lines(out)
    err_lines = parse_lines(err)

    assert [line["level"] for line in out_lines] == ["DEBUG", "INFO"]
    assert [line["level"] for line in err_lines] == ["WARN", "ERROR"]
