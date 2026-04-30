"""klodi-logger — Python implementation of the unified KlodiLogger contract.

Public surface mirrors `@klodi/logger-ts`. The catalog logging contract
(`@klodi/tool-catalog/logging`) ships into this package as
``schemas.json`` (mirrored by the catalog codegen).

Usage::

    from klodi_logger import KlodiLogger

    log = KlodiLogger("klodi-hermes")
    log.info("wake_handler_invoked", {"event_id": eid, "kind": "offer.proposed"})

The contract pins three things every implementation honors:

  1. The four log levels (``DEBUG`` < ``INFO`` < ``WARN`` < ``ERROR``).
  2. The redact list — field names whose values are replaced with
     ``"[redacted]"`` at INFO/WARN/ERROR. DEBUG bypasses redaction.
  3. The required-field map per call-site type — enforced by the
     cross-language integration test, not the logger itself.

Per **D § D15** in
``docs/reviews/2026-04-26-klodi-plugin-multi-lens-review-decisions.md``.
"""

from __future__ import annotations

from klodi_logger.logger import (
    DEFAULT_LOG_LEVEL,
    LOG_LEVELS,
    REDACTED_FIELD_NAMES,
    REDACTION_PLACEHOLDER,
    REQUIRED_FIELDS_BY_SITE,
    KlodiLogger,
    LogLevel,
    level_from_env,
    redact_fields,
)

__all__ = [
    "DEFAULT_LOG_LEVEL",
    "KlodiLogger",
    "LOG_LEVELS",
    "LogLevel",
    "REDACTED_FIELD_NAMES",
    "REDACTION_PLACEHOLDER",
    "REQUIRED_FIELDS_BY_SITE",
    "level_from_env",
    "redact_fields",
]
