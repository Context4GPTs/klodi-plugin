"""Tool catalog loader.

The canonical klodi_* tool surface is owned by
``klodi-plugin/packages/tool-catalog/`` (TypeScript, TypeBox). The
codegen step there writes ``dist/schemas.json`` containing every
tool's NATS subject + JSON Schema params + result. We bundle that file
into this Python package at build time so adapters can register tools
on the host without depending on a TS toolchain.

Public surface:
  * ``TOOL_SUBJECTS``  — ``dict[ToolName, str]``
  * ``TOOL_SCHEMAS``   — ``dict[ToolName, ToolSchema]``
  * ``TOOL_NAMES``     — ``list[ToolName]``
  * ``ToolName``       — a Literal string of every ``klodi_*`` name
"""

from __future__ import annotations

import json
from importlib import resources
from typing import Any, TypedDict


class ToolSchema(TypedDict):
    """Shape of every entry in ``schemas.json``'s ``tools`` map."""

    subject: str
    description: str
    params: dict[str, Any]
    result: dict[str, Any]


def _load_schemas_blob() -> dict[str, Any]:
    """Read the bundled ``schemas.json`` exactly once at import time.

    Uses ``importlib.resources`` so the file resolves correctly whether
    the package is installed editable, as a wheel, or zipapp-bundled.
    """
    with resources.files(__package__).joinpath("schemas.json").open(
        "r", encoding="utf-8"
    ) as fh:
        loaded = json.load(fh)
    if not isinstance(loaded, dict):
        raise RuntimeError(
            "schemas.json malformed: top-level value must be an object,"
            f" got {type(loaded).__name__}"
        )
    return loaded


_BLOB = _load_schemas_blob()
_TOOLS_RAW = _BLOB.get("tools")
if not isinstance(_TOOLS_RAW, dict):
    raise RuntimeError(
        "schemas.json malformed: missing or non-object 'tools' key"
    )


def _build_tools() -> dict[str, ToolSchema]:
    """Validate every entry conforms to ``ToolSchema`` shape."""
    out: dict[str, ToolSchema] = {}
    for name, raw in _TOOLS_RAW.items():
        if not isinstance(raw, dict):
            raise RuntimeError(
                f"schemas.json: tool {name} entry is not an object"
            )
        subject = raw.get("subject")
        params = raw.get("params")
        result = raw.get("result")
        description = raw.get("description", "")
        if not isinstance(subject, str) or not subject:
            raise RuntimeError(
                f"schemas.json: tool {name} missing string 'subject'"
            )
        if not isinstance(params, dict):
            raise RuntimeError(
                f"schemas.json: tool {name} missing object 'params'"
            )
        if not isinstance(result, dict):
            raise RuntimeError(
                f"schemas.json: tool {name} missing object 'result'"
            )
        out[name] = {
            "subject": subject,
            "description": description,
            "params": params,
            "result": result,
        }
    return out


_TOOLS: dict[str, ToolSchema] = _build_tools()

#: All known klodi_* tool names, sorted for deterministic iteration.
TOOL_NAMES: list[str] = sorted(_TOOLS.keys())

#: ``klodi_*`` → NATS subject (e.g. ``p2p.v1.listings.create``).
TOOL_SUBJECTS: dict[str, str] = {
    name: schema["subject"] for name, schema in _TOOLS.items()
}

#: ``klodi_*`` → full ``ToolSchema`` (subject + params + result schemas).
TOOL_SCHEMAS: dict[str, ToolSchema] = _TOOLS


# ToolName is a runtime Literal-like check; static-typed code can still
# import the names directly. We don't synthesize a Literal type because
# the catalog is loaded at runtime.
ToolName = str


__all__ = [
    "TOOL_NAMES",
    "TOOL_SCHEMAS",
    "TOOL_SUBJECTS",
    "ToolName",
    "ToolSchema",
]
