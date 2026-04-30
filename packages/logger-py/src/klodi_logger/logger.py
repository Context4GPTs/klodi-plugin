"""KlodiLogger implementation — emits NDJSON matching the catalog contract.

The contract values (level set, redact list, required-field map) are
loaded from the bundled ``schemas.json`` at import time so the Python
half cannot drift from the TypeScript source of truth.
"""

from __future__ import annotations

import json
import os
import sys
import traceback
from importlib import resources
from typing import Any, Final, Literal, Mapping, Optional, TextIO

LogLevel = Literal["DEBUG", "INFO", "WARN", "ERROR"]


def _load_logging_contract() -> Mapping[str, Any]:
    raw = resources.files("klodi_logger").joinpath("schemas.json").read_text("utf-8")
    catalog = json.loads(raw)
    logging = catalog.get("logging")
    if not isinstance(logging, Mapping):
        raise RuntimeError(
            "klodi_logger: schemas.json missing 'logging' section."
            " Regenerate via pnpm --filter @klodi/tool-catalog codegen.",
        )
    return logging


_CONTRACT: Final[Mapping[str, Any]] = _load_logging_contract()

LOG_LEVELS: Final[tuple[LogLevel, ...]] = tuple(_CONTRACT["log_levels"])
REDACTED_FIELD_NAMES: Final[frozenset[str]] = frozenset(_CONTRACT["redacted_field_names"])
REQUIRED_FIELDS_BY_SITE: Final[Mapping[str, tuple[str, ...]]] = {
    site: tuple(fields) for site, fields in _CONTRACT["required_fields_by_site"].items()
}
REDACTION_PLACEHOLDER: Final[str] = _CONTRACT["redaction_placeholder"]
DEFAULT_LOG_LEVEL: Final[LogLevel] = _CONTRACT["default_log_level"]

_LEVEL_RANK: Final[dict[LogLevel, int]] = {level: idx for idx, level in enumerate(LOG_LEVELS)}


def level_from_env(env: Optional[Mapping[str, str]] = None) -> LogLevel:
    """Return the level from ``LOG_LEVEL`` env or the catalog default."""
    raw = (env if env is not None else os.environ).get("LOG_LEVEL")
    if raw is None:
        return DEFAULT_LOG_LEVEL
    upper = raw.upper()
    if upper in _LEVEL_RANK:
        return upper  # type: ignore[return-value]
    return DEFAULT_LOG_LEVEL


def redact_fields(value: Any) -> Any:
    """Recursively replace redacted-field values with the placeholder.

    Pure function — never mutates the input.
    """
    if isinstance(value, Mapping):
        return {
            key: REDACTION_PLACEHOLDER if key in REDACTED_FIELD_NAMES else redact_fields(val)
            for key, val in value.items()
        }
    if isinstance(value, list):
        return [redact_fields(entry) for entry in value]
    if isinstance(value, tuple):
        return tuple(redact_fields(entry) for entry in value)
    return value


def _now_iso() -> str:
    # Match TS: ISO 8601 with milliseconds, UTC, suffix "Z".
    from datetime import datetime, timezone

    return (
        datetime.now(timezone.utc)
        .isoformat(timespec="milliseconds")
        .replace("+00:00", "Z")
    )


def _describe_error(err: BaseException) -> dict[str, str]:
    tb = traceback.extract_tb(err.__traceback__)
    top_frame = ""
    if tb:
        last = tb[-1]
        top_frame = f'at {last.name} ({last.filename}:{last.lineno})'
    return {
        "name": err.__class__.__name__,
        "message": str(err),
        "top_frame": top_frame,
    }


class KlodiLogger:
    """Emit NDJSON lines matching the ``KlodiLogLine`` shape.

    Construct one per scope (e.g. ``"klodi-hermes"``). Use
    ``child(extra_scope, base_fields=...)`` to derive a sub-scope that
    inherits + extends the parent's base fields.
    """

    def __init__(
        self,
        scope: str,
        *,
        level: Optional[LogLevel] = None,
        stdout: Optional[TextIO] = None,
        stderr: Optional[TextIO] = None,
        base_fields: Optional[Mapping[str, Any]] = None,
    ) -> None:
        self._scope = scope
        self._level: LogLevel = level if level is not None else level_from_env()
        self._stdout: TextIO = stdout if stdout is not None else sys.stdout
        self._stderr: TextIO = stderr if stderr is not None else sys.stderr
        self._base_fields: dict[str, Any] = dict(base_fields or {})

    def error(
        self,
        msg: str,
        fields: Optional[Mapping[str, Any]] = None,
        err: Optional[BaseException] = None,
    ) -> None:
        self._emit("ERROR", msg, fields, err)

    def warn(self, msg: str, fields: Optional[Mapping[str, Any]] = None) -> None:
        self._emit("WARN", msg, fields)

    def info(self, msg: str, fields: Optional[Mapping[str, Any]] = None) -> None:
        self._emit("INFO", msg, fields)

    def debug(self, msg: str, fields: Optional[Mapping[str, Any]] = None) -> None:
        self._emit("DEBUG", msg, fields)

    def child(
        self,
        extra_scope: str,
        base_fields: Optional[Mapping[str, Any]] = None,
    ) -> "KlodiLogger":
        merged: dict[str, Any] = dict(self._base_fields)
        if base_fields:
            merged.update(base_fields)
        return KlodiLogger(
            f"{self._scope}.{extra_scope}",
            level=self._level,
            stdout=self._stdout,
            stderr=self._stderr,
            base_fields=merged,
        )

    def _emit(
        self,
        level: LogLevel,
        msg: str,
        fields: Optional[Mapping[str, Any]],
        err: Optional[BaseException] = None,
    ) -> None:
        if _LEVEL_RANK[level] < _LEVEL_RANK[self._level]:
            return
        merged: dict[str, Any] = dict(self._base_fields)
        if fields:
            merged.update(fields)
        emitted_fields = merged if level == "DEBUG" else redact_fields(merged)
        line: dict[str, Any] = {
            "ts": _now_iso(),
            "level": level,
            "scope": self._scope,
            "msg": msg,
            "fields": emitted_fields,
        }
        if err is not None:
            line["error"] = _describe_error(err)
        target = self._stderr if level in ("ERROR", "WARN") else self._stdout
        target.write(json.dumps(line) + "\n")
        target.flush()
