"""Local (filesystem) klodi tools for the Hermes adapter.

These tools read/write files under ``${KLODI_HOME}`` directly from the
Python adapter process. They are NOT proxied through NATS because they
operate on host-specific local state (creds, policies, sell/buy files)
or require out-of-band orchestration (browser OAuth for register).

Implemented here:

* ``klodi_setup_status``       — gather filesystem checks + derive a phase.
* ``klodi_setup_repair``       — remove creds + config so klodi_register
                                  can run cleanly.
* ``klodi_setup_reseed_policies`` — re-seed negotiation_style + security
                                     policy templates when absent.

Sibling modules hold the other local-state tools:

* ``register.py`` — ``klodi_register`` / ``klodi_register_poll`` (browser
  Auth0 handoff with background session poller).
* ``watch.py`` — ``klodi_watch`` / ``klodi_unwatch`` (server-side
  standing searches; match wakes arrive via the notifications consumer).
"""

from __future__ import annotations

import json
import logging
import os
import shutil
from pathlib import Path
from typing import Any, Optional

from klodi_nats_client import KLODI_DEFAULT_API_URL, default_klodi_home


log = logging.getLogger("klodi_hermes.local_tools")


# ── Path resolution ──────────────────────────────────────────────────

# Per **R § P2-14 (Python)**: source of truth for `${KLODI_HOME}`
# resolution is `klodi_nats_client.paths.default_klodi_home()`. The
# prior local copy lived in 5+ places (OpenClaw, Hermes installer +
# local_tools, nanobot installer, Rust crate) — see the multi-lens
# review for the consolidation rationale.
def _klodi_home() -> Path:
    return default_klodi_home()


def _creds_path() -> Path:
    return _klodi_home() / "nats.creds"


def _config_path() -> Path:
    return _klodi_home() / "config.json"


def _policies_dir() -> Path:
    return _klodi_home() / "policies"


def _negotiation_style_path() -> Path:
    return _policies_dir() / "negotiation_style.md"


def _security_policy_path() -> Path:
    return _policies_dir() / "security.md"


def _bundled_skill_dir() -> Path:
    # The plugin ships its skill at ${plugin_dir}/skills/klodi/ per the
    # Hermes plugin SDK's canonical layout (v0.3.0+). The policy
    # templates seeded by klodi_setup_reseed_policies live alongside
    # SKILL.md in that same bundle.
    return Path(__file__).resolve().parent / "skills" / "klodi"


def _negotiation_style_template_path() -> Path:
    return _bundled_skill_dir() / "templates" / "negotiation_style.template.md"


def _security_policy_template_path() -> Path:
    return _bundled_skill_dir() / "policies" / "security.md"


# ── Config loader ────────────────────────────────────────────────────

def _load_config() -> Optional[dict[str, Any]]:
    path = _config_path()
    if not path.exists():
        return None
    try:
        with path.open("r", encoding="utf-8") as fh:
            parsed = json.load(fh)
    except (OSError, json.JSONDecodeError):
        return None
    if not isinstance(parsed, dict):
        return None
    return parsed


def _config_valid(config: Optional[dict[str, Any]]) -> bool:
    if config is None:
        return False
    return all(
        isinstance(config.get(key), str)
        for key in ("handle", "user_id", "nkey_public", "nats_url")
    )


def _creds_mode_secure() -> bool:
    # "Not group-or-world-readable" — accept 0o600, 0o400, or stricter.
    # A user who hardened creds to 0o400 shouldn't see a "loosen your
    # permissions" warning.
    try:
        mode = _creds_path().stat().st_mode & 0o777
    except OSError:
        return False
    return (mode & 0o077) == 0


def _is_negotiation_style_filled() -> bool:
    # "Filled" = user has edited the template. We detect the original by
    # looking for the sentinel header the template ships with.
    path = _negotiation_style_path()
    if not path.exists():
        return False
    try:
        content = path.read_text(encoding="utf-8")
    except OSError:
        return False
    # Template contains a <!-- SEED: replace this block... --> marker.
    # If still present, the file has not been customised.
    return "<!-- SEED:" not in content


# ── Checks + phase ───────────────────────────────────────────────────

def gather_checks() -> dict[str, Any]:
    config = _load_config()
    creds_present = _creds_path().exists()
    config_present = _config_path().exists()
    return {
        "credentials_present": creds_present,
        "config_present": config_present,
        "config_valid": _config_valid(config),
        "creds_mode_secure": _creds_mode_secure() if creds_present else False,
        "policy_seeded": _negotiation_style_path().exists(),
        "policy_filled": _is_negotiation_style_filled(),
        "security_policy_present": _security_policy_path().exists(),
    }


def derive_phase(c: dict[str, Any]) -> str:
    if not c["credentials_present"] and not c["config_present"]:
        return "unregistered"
    if c["credentials_present"] != c["config_present"]:
        return "corrupt"
    if not c["config_valid"]:
        return "corrupt"
    if not c["security_policy_present"]:
        return "needs_policy"
    if not c["policy_seeded"]:
        return "needs_policy"
    if not c["policy_filled"]:
        return "needs_policy"
    return "ready"


def derive_issues(c: dict[str, Any]) -> list[dict[str, Any]]:
    issues: list[dict[str, Any]] = []

    if not c["credentials_present"] and not c["config_present"]:
        issues.append({
            "code": "not_registered",
            "severity": "error",
            "message": "No credentials found. Run klodi_register to sign up.",
            "fix": {"kind": "tool", "tool": "klodi_register"},
        })
        return issues

    if c["credentials_present"] != c["config_present"]:
        missing = "config.json" if c["credentials_present"] else "nats.creds"
        present = "nats.creds" if c["credentials_present"] else "config.json"
        issues.append({
            "code": "partial_credentials",
            "severity": "error",
            "message": (
                f"Partial state: {present} present, {missing} missing."
                " Clear before re-registering."
            ),
            "fix": {"kind": "tool", "tool": "klodi_setup_repair"},
        })
        return issues

    if not c["config_valid"]:
        issues.append({
            "code": "invalid_config",
            "severity": "error",
            "message": (
                "config.json is missing required fields. Clear and re-register."
            ),
            "fix": {"kind": "tool", "tool": "klodi_setup_repair"},
        })
        return issues

    if not c["creds_mode_secure"]:
        issues.append({
            "code": "creds_perms",
            "severity": "warn",
            "message": (
                "nats.creds is not mode 600. Private credentials should not"
                " be world-readable."
            ),
            "fix": {"kind": "shell", "shell": f"chmod 600 {_creds_path()}"},
        })

    if not c["security_policy_present"]:
        issues.append({
            "code": "security_policy_missing",
            "severity": "error",
            "message": (
                "security.md missing. Non-negotiable hard-rule policy is"
                " required before any tool call — re-seed from the bundle."
            ),
            "fix": {"kind": "tool", "tool": "klodi_setup_reseed_policies"},
        })

    if not c["policy_seeded"]:
        issues.append({
            "code": "negotiation_style_missing",
            "severity": "error",
            "message": (
                "negotiation_style.md missing. The agent needs a pricing +"
                " authorization policy before it can act on the user's behalf."
            ),
            "fix": {"kind": "tool", "tool": "klodi_setup_reseed_policies"},
        })
    elif not c["policy_filled"]:
        issues.append({
            "code": "negotiation_style_unfilled",
            "severity": "warn",
            "message": (
                "negotiation_style.md still holds the template SEED markers."
                " Ask the user to fill it in — the agent will refuse to act"
                " autonomously without explicit authorization levels."
            ),
            "fix": {
                "kind": "dialog",
                "dialog": f"Edit {_negotiation_style_path()}",
            },
        })

    return issues


def _derive_next_step(phase: str, issues: list[dict[str, Any]]) -> Optional[str]:
    if phase == "ready":
        return None
    for issue in issues:
        if issue["severity"] == "error":
            return issue["message"]
    if issues:
        return issues[0]["message"]
    return None


# ── Tool handlers ────────────────────────────────────────────────────

def _json(payload: Any) -> str:
    return json.dumps(payload, indent=2, ensure_ascii=False)


def _handle_setup_status(_args: dict[str, Any], **_kwargs: Any) -> str:
    # Local import: wake_pump_control imports from this module
    # (_config_path), so a top-level import would deadlock at module
    # load time.
    from .wake_pump_control import wake_pump_status

    checks = gather_checks()
    phase = derive_phase(checks)
    issues = derive_issues(checks)
    config = _load_config()
    wake = wake_pump_status()
    log.info(
        "setup_status_probed phase=%s issue_codes=%s wake_pump_running=%s",
        phase,
        [i["code"] for i in issues],
        wake["running"],
    )
    return _json({
        "phase": phase,
        "config": {
            "klodi_home": str(_klodi_home()),
            "api_url": os.environ.get("KLODI_API_URL", KLODI_DEFAULT_API_URL),
            "nats_url": config.get("nats_url") if config else None,
            "handle": config.get("handle") if config else None,
        },
        "checks": checks,
        "issues": issues,
        "wake_pump": wake,
        "next_step": _derive_next_step(phase, issues),
    })


def _handle_setup_repair(_args: dict[str, Any], **_kwargs: Any) -> str:
    # Local import: see _handle_setup_status — the cycle is broken by
    # deferring wake_pump_control's import to call time.
    from .wake_pump_control import stop_wake_pump

    # Drain the wake pump first so in-flight handlers don't fight the
    # creds-removal step.
    stop_wake_pump()

    # Narrow-scope repair: remove only creds + config so klodi_register
    # can run cleanly. Never touches policies/ or any user-authored
    # sell/ + buy/ content — a user rotating creds must not lose
    # negotiation history or policy customisations.
    removed: list[str] = []
    failures: list[dict[str, str]] = []
    for target in (_creds_path(), _config_path()):
        if not target.exists():
            continue
        try:
            target.unlink()
            removed.append(str(target))
        except OSError as err:
            failures.append({"path": str(target), "error": str(err)})

    if failures:
        log.error(
            "setup_repair_failed removed=%s failures=%s",
            removed,
            failures,
        )
        return _json({
            "error": "setup_repair_incomplete",
            "message": (
                "Some files could not be removed. Check filesystem"
                f" permissions on {_klodi_home()} and retry."
            ),
            "removed": removed,
            "failures": failures,
        })

    log.warning("setup_repaired removed=%s", removed)
    return _json({"removed": removed, "failures": failures})


def _handle_setup_reseed_skill(
    _args: dict[str, Any],
    **_kwargs: Any,
) -> str:
    # Per Decision 2 of the 0012 first-pass review: re-run the canonical
    # skill bundle copy from ${plugin_dir}/skills/klodi/ into
    # ${klodi_home}/skill/. Force-overwrite (the bundle is the source of
    # truth; user-editable files live under policies/ + sell/ + buy/).
    source = _bundled_skill_dir()
    target = _klodi_home() / "skill"
    if not source.is_dir():
        log.error("skill_reseed_source_missing path=%s", source)
        return _json({
            "skill_seeded": False,
            "error": f"bundled skill source missing at {source}",
        })
    _klodi_home().mkdir(parents=True, exist_ok=True)
    if target.exists():
        shutil.rmtree(target)
    shutil.copytree(source, target)
    log.info("skill_reseeded source=%s target=%s", source, target)
    return _json({"skill_seeded": True, "target": str(target)})


def _handle_setup_reseed_policies(
    _args: dict[str, Any],
    **_kwargs: Any,
) -> str:
    # Non-destructive: copy bundled templates into the policies dir
    # only if the target file is missing. Never overwrites.
    policies_dir = _policies_dir()
    policies_dir.mkdir(parents=True, exist_ok=True)
    # Explicit mode per **R § P3-9**: mkdir alone honors umask, which on
    # operator-customised shells can be tighter (0077) or looser. Pin to
    # 0o755 so the agent can read the seeded templates regardless of
    # the invoking shell's umask. Skip on platforms where chmod is a
    # no-op (Windows) — log a warning and continue.
    try:
        os.chmod(policies_dir, 0o755)
    except OSError as err:
        log.warning(
            "policies_dir_chmod_failed path=%s error=%s — proceeding"
            " (filesystem may not support POSIX modes).",
            policies_dir,
            err,
        )

    negotiation_style_seeded = _seed_if_absent(
        src=_negotiation_style_template_path(),
        dst=_negotiation_style_path(),
    )
    security_policy_seeded = _seed_if_absent(
        src=_security_policy_template_path(),
        dst=_security_policy_path(),
    )

    log.info(
        "policies_reseeded negotiation_style=%s security=%s",
        negotiation_style_seeded,
        security_policy_seeded,
    )
    return _json({
        "negotiation_style_seeded": negotiation_style_seeded,
        "security_policy_seeded": security_policy_seeded,
    })


def _seed_if_absent(*, src: Path, dst: Path) -> bool:
    if dst.exists():
        return False
    if not src.exists():
        raise RuntimeError(
            f"Template missing at {src}. Plugin packaging is broken —"
            " the skill bundle must be copied into the plugin dir."
        )
    shutil.copyfile(src, dst)
    return True


# ── Registration helper ──────────────────────────────────────────────

def register_local_tools(ctx: Any) -> int:
    """Register the local klodi tools on the Hermes tool surface.

    Called from __init__.py::register(ctx) after the request-bridge
    tools have been registered. These tools have no ``check_fn`` —
    they always run, because they're how the user recovers from a
    broken setup in the first place.

    Returns the number of tools registered so the caller can report an
    accurate count in its boot log.
    """
    specs = [
        (
            "klodi_setup_status",
            "🩺",
            (
                "Return the current klodi setup phase, a full check report,"
                " and the exact next step to reach `ready`. Call at the start"
                " of every session and any time the agent suspects setup may"
                " be incomplete."
            ),
            _handle_setup_status,
        ),
        (
            "klodi_setup_repair",
            "🛠️",
            (
                "Remove nats.creds + config.json so klodi_register can run"
                " cleanly. Preserves policies/, sell/, buy/. Use when"
                " klodi_setup_status reports a corrupt or partial-creds state."
            ),
            _handle_setup_repair,
        ),
        (
            "klodi_setup_reseed_policies",
            "📄",
            (
                "Re-seed negotiation_style.md and security.md from the bundled"
                " templates if absent. Never overwrites existing files. Use"
                " when klodi_setup_status reports a missing policy file."
            ),
            _handle_setup_reseed_policies,
        ),
        (
            "klodi_setup_reseed_skill",
            "📚",
            (
                "Force-copy the canonical klodi skill bundle from the adapter's"
                " bundled skills/klodi/ tree into ${klodi_home}/skill/. Use"
                " when the on-disk skill drifts from the plugin version (e.g."
                " after a plugin upgrade). Policies, sell/, and buy/ files are"
                " untouched."
            ),
            _handle_setup_reseed_skill,
        ),
    ]
    for name, emoji, description, handler in specs:
        ctx.register_tool(
            name=name,
            toolset="klodi",
            schema={
                "name": name,
                "description": description,
                "parameters": {
                    "type": "object",
                    "properties": {},
                    "additionalProperties": False,
                },
            },
            handler=handler,
            check_fn=None,
            requires_env=[],
            is_async=False,
            description=description,
            emoji=emoji,
        )
    return len(specs)


__all__ = [
    "derive_issues",
    "derive_phase",
    "gather_checks",
    "register_local_tools",
]
