"""Local (filesystem) klodi tools for the nanobot adapter.

These tools read/write files under ``${KLODI_HOME}`` directly from the
nanobot daemon process. They are NOT proxied through NATS because they
operate on host-specific local state (creds, policies, sell/buy files)
or require out-of-band orchestration (browser OAuth for register).

Implemented per **D § D4** + Phase 4 contribution doc "Deferred —
D4 nanobot setup family":

* ``klodi_setup_status``        — gather filesystem checks + derive a phase.
* ``klodi_setup_repair``        — remove creds + config so klodi_register
                                  can run cleanly.
* ``klodi_setup_reseed_policies`` — re-seed negotiation_style + security
                                    policy templates when absent.
* ``klodi_setup_reseed_skill``   — force-copy the canonical skill bundle.
* ``klodi_register``             — kick off browser-mediated Auth0 handoff.
* ``klodi_register_poll``        — poll a registration session synchronously.
* ``klodi_health``               — probe whoami + report connection status.
* ``klodi_watch``                — register server-side standing search.
* ``klodi_unwatch``              — remove a standing search.

Mirrors ``klodi-plugin/adapters/hermes/{local_tools,register,watch}.py``
file by file. Hermes-specific business logic stays per-host; the cross-host
primitives (``CHANNEL_MESSAGE_PARAMS``, ``default_klodi_home``,
``default_api_url``) are imported from ``klodi_nats_client`` so both
adapters speak the same on-disk and on-wire contracts.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import shutil
import ssl
import threading
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path
from typing import Any, Optional

from klodi_nats_client import (
    KLODI_DEFAULT_API_URL,
    KlodiRequestError,
    assert_encrypted_or_localhost,
    default_klodi_home,
)
from klodi_nats_client.constants import (
    REGISTER_POLL_CEILING_SECONDS,
    REGISTER_POLL_INTERVAL_SECONDS,
)
from klodi_nats_client.secret_write import klodi_secret_write

from nanobot_client import get_client, is_client_connected


log = logging.getLogger("klodi_nanobot.local_tools")


# ── Path resolution ──────────────────────────────────────────────────


def _creds_path() -> Path:
    return default_klodi_home() / "nats.creds"


def _config_path() -> Path:
    return default_klodi_home() / "config.json"


def _policies_dir() -> Path:
    return default_klodi_home() / "policies"


def _negotiation_style_path() -> Path:
    return _policies_dir() / "negotiation_style.md"


def _security_policy_path() -> Path:
    return _policies_dir() / "security.md"


def _bundled_skill_dir() -> Path:
    """The plugin ships its skill at ``${plugin_dir}/skills/klodi/`` per
    the canonical layout. Policy templates seeded by
    ``klodi_setup_reseed_policies`` live alongside SKILL.md in that
    same bundle."""
    return Path(__file__).resolve().parent / "skills" / "klodi"


def _negotiation_style_template_path() -> Path:
    return _bundled_skill_dir() / "templates" / "negotiation_style.template.md"


def _security_policy_template_path() -> Path:
    return _bundled_skill_dir() / "policies" / "security.md"


def _buy_dir() -> Path:
    return default_klodi_home() / "buy"


def _buy_path(slug: str) -> Path:
    return _buy_dir() / f"{slug}.md"


# ── Config + creds checks ────────────────────────────────────────────


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
    """0o600 OR 0o400 are accepted — tighter than world/group readable."""
    try:
        mode = _creds_path().stat().st_mode & 0o777
    except OSError:
        return False
    return (mode & 0o077) == 0


def _is_negotiation_style_filled() -> bool:
    path = _negotiation_style_path()
    if not path.exists():
        return False
    try:
        content = path.read_text(encoding="utf-8")
    except OSError:
        return False
    return "<!-- SEED:" not in content


def gather_checks() -> dict[str, Any]:
    creds_present = _creds_path().exists()
    config_present = _config_path().exists()
    config = _load_config()
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


def _derive_next_step(
    phase: str, issues: list[dict[str, Any]]
) -> Optional[str]:
    if phase == "ready":
        return None
    for issue in issues:
        if issue["severity"] == "error":
            return issue["message"]
    if issues:
        return issues[0]["message"]
    return None


# ── Setup tool handlers ──────────────────────────────────────────────


def handle_setup_status(_args: dict[str, Any]) -> dict[str, Any]:
    checks = gather_checks()
    phase = derive_phase(checks)
    issues = derive_issues(checks)
    config = _load_config()
    log.info(
        "setup_status_probed phase=%s issue_codes=%s",
        phase,
        [i["code"] for i in issues],
    )
    return {
        "phase": phase,
        "config": {
            "klodi_home": str(default_klodi_home()),
            "api_url": os.environ.get("KLODI_API_URL", KLODI_DEFAULT_API_URL),
            "nats_url": config.get("nats_url") if config else None,
            "handle": config.get("handle") if config else None,
        },
        "checks": checks,
        "issues": issues,
        "next_step": _derive_next_step(phase, issues),
    }


def handle_setup_repair(_args: dict[str, Any]) -> dict[str, Any]:
    """Narrow-scope repair: remove only creds + config so klodi_register
    can run cleanly. Never touches policies/ or any user-authored
    sell/ + buy/ content — a user rotating creds must not lose
    negotiation history or policy customisations."""
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
        return {
            "error": "setup_repair_incomplete",
            "message": (
                "Some files could not be removed. Check filesystem"
                f" permissions on {default_klodi_home()} and retry."
            ),
            "removed": removed,
            "failures": failures,
        }
    log.warning("setup_repaired removed=%s", removed)
    return {"removed": removed, "failures": failures}


def handle_setup_reseed_policies(_args: dict[str, Any]) -> dict[str, Any]:
    """Non-destructive: copy bundled templates into the policies dir
    only if the target file is missing. Per **R § P3-9** the policies/
    dir is chmod'd to 0o755 explicitly so the agent can read seeded
    templates regardless of the invoking shell's umask."""
    policies_dir = _policies_dir()
    policies_dir.mkdir(parents=True, exist_ok=True)
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
    return {
        "negotiation_style_seeded": negotiation_style_seeded,
        "security_policy_seeded": security_policy_seeded,
    }


def handle_setup_reseed_skill(_args: dict[str, Any]) -> dict[str, Any]:
    """Force-copy the canonical klodi skill bundle into
    ``${klodi_home}/skill/``. Mirrors hermes Decision-2 semantics."""
    source = _bundled_skill_dir()
    target = default_klodi_home() / "skill"
    if not source.is_dir():
        log.error("skill_reseed_source_missing path=%s", source)
        return {
            "skill_seeded": False,
            "error": f"bundled skill source missing at {source}",
        }
    default_klodi_home().mkdir(parents=True, exist_ok=True)
    if target.exists():
        shutil.rmtree(target)
    shutil.copytree(source, target)
    log.info("skill_reseeded source=%s target=%s", source, target)
    return {"skill_seeded": True, "target": str(target)}


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


# ── Register / register-poll handlers ────────────────────────────────


_POLL_INTERVAL_S = float(REGISTER_POLL_INTERVAL_SECONDS)
_POLL_CEILING_S = float(REGISTER_POLL_CEILING_SECONDS)

_IN_FLIGHT: dict[str, "_PollState"] = {}
_LOCK = threading.Lock()


class _PollState:
    """Mutable state shared between the background thread and the
    klodi_register_poll manual fallback."""

    __slots__ = ("session_id", "status", "result", "started_at", "thread")

    def __init__(
        self, session_id: str, thread: Optional[threading.Thread]
    ) -> None:
        self.session_id = session_id
        self.status: str = "pending"
        self.result: Optional[dict[str, Any]] = None
        self.started_at = time.time()
        self.thread = thread


def _api_url() -> str:
    return os.environ.get("KLODI_API_URL", KLODI_DEFAULT_API_URL).rstrip("/")


def _is_uuid(value: str) -> bool:
    try:
        uuid.UUID(value)
        return True
    except ValueError:
        return False


def handle_register(_args: dict[str, Any]) -> dict[str, Any]:
    if _load_config() is not None:
        existing = _load_config() or {}
        return {
            "status": "already_registered",
            "handle": existing.get("handle"),
            "user_id": existing.get("user_id"),
        }
    session_id = str(uuid.uuid4())
    api_url = _api_url()
    auth_url = f"{api_url}/authorize?session={session_id}"
    poll_url = f"{api_url}/api/sessions/{session_id}"
    thread = threading.Thread(
        target=_poll_loop,
        args=(session_id,),
        name=f"klodi-register-poll-{session_id[:8]}",
        daemon=True,
    )
    with _LOCK:
        _IN_FLIGHT[session_id] = _PollState(session_id, thread)
    thread.start()
    log.info("register_started session_id=%s", session_id)
    return {
        "status": "awaiting_browser",
        "message": (
            f"Open this URL to register: {auth_url}. The plugin will"
            " surface the result on the next klodi_register_poll call"
            " (or on the daemon's wake-bus channel)."
        ),
        "auth_url": auth_url,
        "poll_url": poll_url,
        "session_id": session_id,
    }


def handle_register_poll(args: dict[str, Any]) -> dict[str, Any]:
    session_id = args.get("session_id")
    if not isinstance(session_id, str) or not _is_uuid(session_id):
        return {
            "error": "INVALID_SESSION_ID",
            "message": (
                "session_id must be the UUID returned by klodi_register."
            ),
        }
    with _LOCK:
        state = _IN_FLIGHT.get(session_id)
    if state is not None and state.status != "pending" and state.result:
        return state.result
    result = _fetch_session(session_id)
    if result.get("status") == "completed":
        try:
            _persist_credentials(result)
        except OSError as err:
            log.error("register_persist_failed error=%s", err)
            return {
                "error": "PERSIST_FAILED",
                "message": str(err),
            }
    if state is not None:
        state.status = result.get("status", "error")
        state.result = result
    return result


def _poll_loop(session_id: str) -> None:
    state = _IN_FLIGHT.get(session_id)
    if state is None:
        return
    deadline = state.started_at + _POLL_CEILING_S
    while time.time() < deadline:
        time.sleep(_POLL_INTERVAL_S)
        try:
            result = _fetch_session(session_id)
        except Exception as err:  # noqa: BLE001 — background thread, log + retry
            log.warning(
                "register_poll_fetch_failed session_id=%s error=%s",
                session_id,
                err,
            )
            continue
        status = result.get("status")
        if status == "pending":
            continue
        if status == "completed":
            try:
                _persist_credentials(result)
            except OSError as err:
                log.error(
                    "register_persist_failed session_id=%s error=%s",
                    session_id,
                    err,
                )
                state.status = "error"
                state.result = {
                    "error": "PERSIST_FAILED",
                    "message": str(err),
                }
                return
            state.status = "completed"
            state.result = {
                "status": "registered",
                "handle": result.get("handle"),
                "user_id": result.get("user_id"),
                "nats_url": result.get("nats_url"),
            }
            log.info(
                "register_claimed session_id=%s handle=%s",
                session_id,
                result.get("handle"),
            )
            return
        state.status = str(status or "error")
        state.result = result
        log.info(
            "register_settled session_id=%s status=%s",
            session_id,
            status,
        )
        return
    state.status = "timeout"
    state.result = {
        "status": "timeout",
        "message": (
            f"Registration session {session_id} did not complete within"
            " 10 minutes. Call klodi_register again for a fresh session."
        ),
    }
    log.warning("register_poll_timeout session_id=%s", session_id)


def _fetch_session(session_id: str) -> dict[str, Any]:
    url = f"{_api_url()}/api/sessions/{session_id}"
    request = urllib.request.Request(url, method="GET")
    request.add_header("User-Agent", "klodi-nanobot-adapter/0.2")
    ctx = ssl.create_default_context()
    try:
        with urllib.request.urlopen(request, timeout=15, context=ctx) as resp:
            body = resp.read().decode("utf-8")
            return json.loads(body) if body else {}
    except urllib.error.HTTPError as err:
        try:
            body = err.read().decode("utf-8")
            return json.loads(body)
        except Exception:  # noqa: BLE001 — boundary
            return {
                "status": "error",
                "error": "HTTP_ERROR",
                "message": f"{err.code} {err.reason}",
            }
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as err:
        return {
            "status": "error",
            "error": "NETWORK_ERROR",
            "message": str(err),
        }


def _persist_credentials(result: dict[str, Any]) -> None:
    handle = result.get("handle")
    user_id = result.get("user_id")
    nkey_public = result.get("nkey_public")
    nats_creds = result.get("nats_creds")
    nats_url = result.get("nats_url")
    for field, value in (
        ("handle", handle),
        ("user_id", user_id),
        ("nkey_public", nkey_public),
        ("nats_creds", nats_creds),
        ("nats_url", nats_url),
    ):
        if not isinstance(value, str) or not value:
            raise OSError(f"session claim missing {field}")
    # Delegates to the single shared client guard so persist-time and
    # connect-time policy can never drift — accepts `wss://` / `tls://`,
    # rejects `ws://` / `nats://` off localhost (D § D10, P2-17 closure).
    assert isinstance(nats_url, str)  # narrowed above
    try:
        assert_encrypted_or_localhost(nats_url)
    except ValueError as err:
        raise OSError(
            f"registration response had a plaintext nats_url ({nats_url}); "
            "refusing to persist. Verify your KLODI_API_URL.",
        ) from err
    klodi_home = default_klodi_home()
    klodi_home.mkdir(parents=True, exist_ok=True)
    try:
        os.chmod(klodi_home, 0o700)
    except OSError:
        pass
    klodi_secret_write(_creds_path(), nats_creds)
    klodi_secret_write(
        _config_path(),
        json.dumps(
            {
                "handle": handle,
                "user_id": user_id,
                "nkey_public": nkey_public,
                "nats_url": nats_url,
            },
            indent=2,
        ),
    )


# ── klodi_health ─────────────────────────────────────────────────────


async def _whoami_round_trip() -> dict[str, Any]:
    """Round-trip through ``p2p.v1.users.whoami`` to surface the live
    server-side identity. Returns ``{ok, latency_ms, user_id, handle}``
    on success; raises on transport / handler failure."""
    client = get_client()
    started = time.time()
    response = await client.request("p2p.v1.users.whoami", {})
    latency_ms = int((time.time() - started) * 1000)
    return {
        "ok": True,
        "latency_ms": latency_ms,
        "user_id": response.get("user_id") if isinstance(response, dict) else None,
        "handle": response.get("handle") if isinstance(response, dict) else None,
    }


def handle_health(_args: dict[str, Any]) -> dict[str, Any]:
    """Probe NATS connectivity. Returns the live whoami round-trip
    latency on the happy path; on failure surfaces the connection
    state + error text so the agent / operator can see what went wrong."""
    connected = is_client_connected()
    if not connected:
        return {
            "ok": False,
            "connected": False,
            "issue": (
                "klodi NATS connection is not open. Check the daemon"
                " status (klodi-nanobot-daemon) and run klodi_setup_status."
            ),
        }
    try:
        result = asyncio.run(_whoami_round_trip())
    except KlodiRequestError as err:
        return {
            "ok": False,
            "connected": True,
            "issue": (
                f"whoami request failed: {err.code or 'request_failed'}: {err}"
            ),
        }
    except BaseException as err:  # noqa: BLE001 — boundary
        return {
            "ok": False,
            "connected": True,
            "issue": f"whoami transport error: {err}",
        }
    result["connected"] = True
    return result


# ── Watch / unwatch handlers ─────────────────────────────────────────


_SLUG_PATTERN = re.compile(r"^[a-z0-9][a-z0-9._-]*$")
_SLUG_MAX_LENGTH = 120


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
    criteria: dict[str, Any] = {}
    for key in ("query", "max_price", "currency"):
        value = args.get(key)
        if value is not None:
            criteria[key] = value
    return criteria


def _ensure_buy_dir() -> None:
    path = _buy_dir()
    path.mkdir(parents=True, exist_ok=True)
    try:
        os.chmod(path, 0o700)
    except OSError:
        pass


def _buy_file_template(slug: str, criteria: dict[str, Any]) -> str:
    public = json.dumps(criteria, indent=2)
    return (
        f"# klodi buy/{slug}\n\n"
        "Persistent buy-watch managed by the marketplace.\n\n"
        "## Public criteria (sent to server)\n\n"
        f"```json\n{public}\n```\n\n"
        "## Private evaluation (never leaves this machine)\n\n"
        "<!-- SEED: replace this block with brand preferences,\n"
        "     condition floor, seller-rating threshold, walk-away\n"
        "     price, negotiation posture. The agent reads these on\n"
        "     every search.match wake before deciding to act. -->\n"
    )


async def _searches_create(slug: str, criteria: dict[str, Any]) -> dict[str, Any]:
    client = get_client()
    return await client.request(
        "p2p.v1.searches.create",
        {"slug": slug, **criteria},
    )


async def _searches_delete(slug: str) -> dict[str, Any]:
    client = get_client()
    return await client.request("p2p.v1.searches.delete", {"slug": slug})


def handle_watch(args: dict[str, Any]) -> dict[str, Any]:
    slug_raw = args.get("slug")
    if not isinstance(slug_raw, str):
        return {
            "error": "INVALID_REQUEST",
            "message": "slug is required (lowercase, [a-z0-9._-])",
        }
    try:
        slug = _validate_slug(slug_raw)
    except ValueError as err:
        return {"error": "INVALID_SLUG", "message": str(err)}
    criteria = _build_criteria(args)
    try:
        response = asyncio.run(_searches_create(slug, criteria))
    except KlodiRequestError as err:
        return {
            "error": err.code or "request_failed",
            "message": str(err),
        }
    except BaseException as err:  # noqa: BLE001 — boundary
        return {"error": "transport_error", "message": str(err)}
    try:
        _ensure_buy_dir()
        _buy_path(slug).write_text(
            _buy_file_template(slug, criteria), encoding="utf-8"
        )
    except OSError as err:
        log.warning(
            "watch_buy_file_write_failed slug=%s error=%s", slug, err
        )
        return {
            "error": "BUY_FILE_WRITE_FAILED",
            "message": str(err),
            "slug": slug,
            "watch_registered": True,
        }
    log.info("watch_created slug=%s", slug)
    search_id = (
        response.get("search_id") if isinstance(response, dict) else None
    )
    return {
        "slug": slug,
        "search_id": search_id,
        "buy_file_path": str(_buy_path(slug)),
    }


def handle_unwatch(args: dict[str, Any]) -> dict[str, Any]:
    slug_raw = args.get("slug")
    if not isinstance(slug_raw, str):
        return {
            "error": "INVALID_REQUEST",
            "message": "slug is required (string)",
        }
    try:
        slug = _validate_slug(slug_raw)
    except ValueError as err:
        return {"error": "INVALID_SLUG", "message": str(err)}
    server_removed = True
    try:
        asyncio.run(_searches_delete(slug))
    except KlodiRequestError as err:
        # If the server says NOT_FOUND we still want to delete the buy
        # file so the local + server states converge.
        log.info("unwatch_server_response slug=%s code=%s", slug, err.code)
        server_removed = False
    except BaseException as err:  # noqa: BLE001 — boundary
        return {"error": "transport_error", "message": str(err)}
    buy_file_removed = False
    try:
        _buy_path(slug).unlink()
        buy_file_removed = True
    except FileNotFoundError:
        pass
    except OSError as err:
        return {
            "error": "BUY_FILE_DELETE_FAILED",
            "message": str(err),
            "slug": slug,
        }
    log.info(
        "watch_removed slug=%s buy_file_removed=%s server_removed=%s",
        slug,
        buy_file_removed,
        server_removed,
    )
    return {
        "slug": slug,
        "removed": server_removed,
        "buy_file_removed": buy_file_removed,
    }


# ── Tool definitions ─────────────────────────────────────────────────

#: Names of every local tool nanobot exposes — used by the dispatcher
#: in nanobot_tools.handle to short-circuit before reaching call_tool.
LOCAL_TOOL_NAMES: frozenset[str] = frozenset({
    "klodi_setup_status",
    "klodi_setup_repair",
    "klodi_setup_reseed_policies",
    "klodi_setup_reseed_skill",
    "klodi_register",
    "klodi_register_poll",
    "klodi_health",
    "klodi_watch",
    "klodi_unwatch",
})


_NO_PARAMS: dict[str, Any] = {
    "type": "object",
    "properties": {},
    "additionalProperties": False,
}

_REGISTER_POLL_PARAMS: dict[str, Any] = {
    "type": "object",
    "properties": {
        "session_id": {
            "type": "string",
            "description": "UUID returned by klodi_register.",
        },
    },
    "required": ["session_id"],
    "additionalProperties": False,
}

_WATCH_PARAMS: dict[str, Any] = {
    "type": "object",
    "properties": {
        "slug": {
            "type": "string",
            "description": (
                "Lowercase identifier ([a-z0-9._-]). Names the buy/<slug>.md"
                " file and the server-side standing search."
            ),
        },
        "query": {
            "type": "string",
            "description": "Free-text query passed to the marketplace search.",
        },
        "max_price": {
            "type": "integer",
            "minimum": 0,
            "description": "Integer cents ceiling for matching listings.",
        },
        "currency": {
            "type": "string",
            "description": "ISO-4217 currency code (e.g. USD, EUR).",
        },
    },
    "required": ["slug"],
    "additionalProperties": False,
}

_UNWATCH_PARAMS: dict[str, Any] = {
    "type": "object",
    "properties": {
        "slug": {
            "type": "string",
            "description": "slug of the watch to remove",
        },
    },
    "required": ["slug"],
    "additionalProperties": False,
}


LOCAL_TOOL_DEFINITIONS: list[dict[str, Any]] = [
    {
        "name": "klodi_setup_status",
        "description": (
            "Inspect klodi setup state. Reports phase + missing files +"
            " user identity (when registered). Call at session start."
        ),
        "parameters": _NO_PARAMS,
    },
    {
        "name": "klodi_setup_repair",
        "description": (
            "Remove nats.creds + config.json so klodi_register can run"
            " cleanly. Preserves policies/, sell/, buy/."
        ),
        "parameters": _NO_PARAMS,
    },
    {
        "name": "klodi_setup_reseed_policies",
        "description": (
            "Re-seed negotiation_style.md and security.md from the"
            " bundled templates if absent. Never overwrites existing files."
        ),
        "parameters": _NO_PARAMS,
    },
    {
        "name": "klodi_setup_reseed_skill",
        "description": (
            "Force-copy the canonical klodi skill bundle into"
            " ${klodi_home}/skill/. Use after a plugin upgrade where the"
            " on-disk skill drifted from the new plugin version."
        ),
        "parameters": _NO_PARAMS,
    },
    {
        "name": "klodi_register",
        "description": (
            "Open the klodi registration browser flow. Returns a"
            " session_id the agent polls via klodi_register_poll until"
            " the user completes OAuth."
        ),
        "parameters": _NO_PARAMS,
    },
    {
        "name": "klodi_register_poll",
        "description": (
            "Poll a klodi registration session until terminal. Persists"
            " nats.creds + config.json on success."
        ),
        "parameters": _REGISTER_POLL_PARAMS,
    },
    {
        "name": "klodi_health",
        "description": (
            "Probe klodi connectivity. Round-trips through users.whoami"
            " and reports the persistent NATS connection status."
        ),
        "parameters": _NO_PARAMS,
    },
    {
        "name": "klodi_watch",
        "description": (
            "Register a standing search and seed the local buy/<slug>.md"
            " file. Composite of klodi_searches_create + filesystem write."
        ),
        "parameters": _WATCH_PARAMS,
    },
    {
        "name": "klodi_unwatch",
        "description": (
            "Stop a standing search and delete the local buy/<slug>.md file."
            " Composite of the server-side searches.delete + filesystem unlink."
        ),
        "parameters": _UNWATCH_PARAMS,
    },
]


# ── Dispatcher ───────────────────────────────────────────────────────


_HANDLERS: dict[str, Any] = {
    "klodi_setup_status": handle_setup_status,
    "klodi_setup_repair": handle_setup_repair,
    "klodi_setup_reseed_policies": handle_setup_reseed_policies,
    "klodi_setup_reseed_skill": handle_setup_reseed_skill,
    "klodi_register": handle_register,
    "klodi_register_poll": handle_register_poll,
    "klodi_health": handle_health,
    "klodi_watch": handle_watch,
    "klodi_unwatch": handle_unwatch,
}


def dispatch_local_tool(name: str, args: dict[str, Any]) -> dict[str, Any]:
    """Route ``name`` to its local-tool handler. Returns the handler's
    raw dict response — the caller is responsible for json.dumps if a
    string envelope is required (nanobot's tool decorator). Raises
    ``KeyError`` for unknown names so the caller can surface
    ``UNKNOWN_TOOL`` consistently with ``call_tool``."""
    handler = _HANDLERS.get(name)
    if handler is None:
        raise KeyError(f"Unknown local tool: {name}")
    return handler(args)


__all__ = [
    "LOCAL_TOOL_DEFINITIONS",
    "LOCAL_TOOL_NAMES",
    "derive_issues",
    "derive_phase",
    "dispatch_local_tool",
    "gather_checks",
    "handle_health",
    "handle_register",
    "handle_register_poll",
    "handle_setup_repair",
    "handle_setup_reseed_policies",
    "handle_setup_reseed_skill",
    "handle_setup_status",
    "handle_unwatch",
    "handle_watch",
]
