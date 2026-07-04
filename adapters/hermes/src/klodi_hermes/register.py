"""klodi_register / klodi_register_poll — browser-mediated Auth0 handoff.

Registration is necessarily out-of-band from the NATS connection: at
sign-up time the user has no creds yet, so they can't open a NATS-WS
connection. The adapter polls the marketplace's HTTP `/api/sessions`
endpoint until the user completes the browser handoff, then writes
nats.creds + config.json under ``${KLODI_HOME}``. After that the
adapter can connect via NATS-WS and the rest of 0012 applies.

Flow:

  1. Agent calls ``klodi_register`` → this module mints a UUID session,
     returns the auth URL, and spawns a background thread that polls
     ``GET <api>/api/sessions/<id>`` every ``_POLL_INTERVAL_S`` seconds
     for up to ``_POLL_CEILING_S`` seconds.
  2. User opens the auth URL in a browser, completes Auth0, picks a
     handle.
  3. The marketplace claims the session (status=completed), and on the
     next poll our thread receives the cred envelope, writes
     ``config.json`` + ``nats.creds`` under ``${KLODI_HOME}`` (mode
     0600 on the creds), and injects a system message into the active
     Hermes session so the agent wakes on the success.
  4. ``klodi_register_poll`` is a manual fallback — runs the same
     endpoint fetch once and claims synchronously. Useful when the
     background poller was never started (e.g. the plugin was
     reloaded mid-flow), or when the agent wants a deterministic
     "am I done yet" without a wake event.

The session endpoint is one-shot: the first caller that observes
``natsCreds IS NOT NULL`` wipes the column in the same atomic update.
Subsequent calls return ``CREDENTIALS_ALREADY_CLAIMED``. Both the
background thread and ``klodi_register_poll`` respect this — a race
between them resolves cleanly.
"""

from __future__ import annotations

import json
import logging
import os
import ssl
import threading
import time
import urllib.error
import urllib.request
import uuid
from typing import Any, Optional

from klodi_nats_client import (
    KLODI_DEFAULT_API_URL,
    assert_encrypted_or_localhost,
    persist_nats_ca,
)
from klodi_nats_client.secret_write import klodi_secret_write

from .local_tools import (
    _config_path,
    _creds_path,
    _klodi_home,
    _load_config,
)


log = logging.getLogger("klodi_hermes.register")


# Per **R § P2-10** + **D § Cluster V**: cadence lives in the catalog.
# `klodi_nats_client.constants` reads them from the bundled
# `schemas.json` so all hosts agree without hand-maintained drift.
from klodi_nats_client.constants import (  # noqa: E402 — late-bound; module setup above
    REGISTER_POLL_CEILING_SECONDS,
    REGISTER_POLL_INTERVAL_SECONDS,
)

_POLL_INTERVAL_S = float(REGISTER_POLL_INTERVAL_SECONDS)
_POLL_CEILING_S = float(REGISTER_POLL_CEILING_SECONDS)


# Module-level state so klodi_register_poll can detect an in-flight
# background poll without requiring the agent to hold session_id across
# turns. A dict (rather than a global var) keeps the door open for
# multiple concurrent attempts, though in practice Hermes runs one.
_IN_FLIGHT: dict[str, "_PollState"] = {}
_LOCK = threading.Lock()

# Captured at plugin-register time so the background thread can wake
# the agent on success. None in gateway-only mode.
_CTX: Any = None


class _PollState:
    """Mutable state shared between the background thread and the
    klodi_register_poll manual fallback."""

    __slots__ = ("session_id", "status", "result", "started_at", "thread")

    def __init__(self, session_id: str, thread: Optional[threading.Thread]):
        self.session_id = session_id
        self.status: str = "pending"  # pending|completed|expired|error
        self.result: Optional[dict[str, Any]] = None
        self.started_at = time.time()
        self.thread = thread


# ── Public entry points ──────────────────────────────────────────────

def bind_ctx(ctx: Any) -> None:
    """Called from __init__.py::register(ctx) so the background poller
    can wake the agent on completion."""
    global _CTX
    _CTX = ctx


def handle_register(_args: dict[str, Any], **_kwargs: Any) -> str:
    if _load_config() is not None:
        # Already registered — nothing to do. Return the handle so the
        # agent can confirm identity without needing a separate
        # klodi_whoami round-trip on this path.
        existing = _load_config() or {}
        return json.dumps({
            "status": "already_registered",
            "handle": existing.get("handle"),
            "user_id": existing.get("user_id"),
        })

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
    return json.dumps({
        "status": "awaiting_browser",
        "message": (
            f"Open this URL to register: {auth_url}. The plugin will"
            " wake you automatically when the browser flow completes"
            " (up to 10 minutes). Use klodi_register_poll as a manual"
            " fallback if the wake never arrives."
        ),
        "auth_url": auth_url,
        "poll_url": poll_url,
        "session_id": session_id,
    })


def handle_register_poll(args: dict[str, Any], **_kwargs: Any) -> str:
    session_id = args.get("session_id")
    if not isinstance(session_id, str) or not _is_uuid(session_id):
        return json.dumps({
            "error": "INVALID_SESSION_ID",
            "message": (
                "session_id must be the UUID returned by klodi_register."
            ),
        })

    with _LOCK:
        state = _IN_FLIGHT.get(session_id)

    # Settled state dominates — if the background thread already
    # observed a terminal result, surface it instead of re-fetching.
    if state is not None and state.status != "pending" and state.result:
        return json.dumps(state.result)

    # Otherwise fetch once, synchronously. Preempting the poller with a
    # manual fetch is fine — both paths race the same atomic claim on
    # the server side; the loser just sees already_claimed.
    result = _fetch_session(session_id)
    if result.get("status") == "completed":
        try:
            _persist_credentials(result)
        except OSError as err:
            log.error("register_persist_failed error=%s", err)
            return json.dumps({
                "error": "PERSIST_FAILED",
                "message": str(err),
            })

    if state is not None:
        state.status = result.get("status", "error")
        state.result = result

    return json.dumps(result)


# ── Internals ────────────────────────────────────────────────────────

def _api_url() -> str:
    # Source of truth for the canonical API URL is the catalog (D9).
    # Override via env var.
    return os.environ.get("KLODI_API_URL", KLODI_DEFAULT_API_URL).rstrip("/")


def _poll_loop(session_id: str) -> None:
    state = _IN_FLIGHT.get(session_id)
    if state is None:
        return  # defensive — shouldn't happen but if it does just exit

    deadline = state.started_at + _POLL_CEILING_S
    while time.time() < deadline:
        time.sleep(_POLL_INTERVAL_S)
        try:
            result = _fetch_session(session_id)
        except Exception as err:  # noqa: BLE001 — background thread, log and retry
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
            _wake_agent(state.result)
            log.info(
                "register_claimed session_id=%s handle=%s",
                session_id,
                result.get("handle"),
            )
            return
        # expired | already_claimed | anything else — settle and exit.
        state.status = str(status or "error")
        state.result = result
        _wake_agent(result)
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
    request.add_header("User-Agent", "klodi-hermes-adapter/0.1")

    ctx = ssl.create_default_context()
    try:
        with urllib.request.urlopen(request, timeout=15, context=ctx) as resp:
            body = resp.read().decode("utf-8")
            return json.loads(body) if body else {}
    except urllib.error.HTTPError as err:
        # 404 NOT_FOUND on this endpoint is the expected state until
        # the user has opened the authorize URL in their browser. The
        # web app's `GET /authorize` handler is what creates the
        # session row server-side
        # (apps/web/src/app/authorize/route.ts). Until then the
        # polling endpoint legitimately has nothing to report; map
        # it to ``status=pending`` so both the background poll loop
        # and the synchronous `klodi_register_poll` fallback keep
        # waiting instead of treating it as a terminal failure.
        if err.code == 404:
            return {
                "status": "pending",
                "reason": "awaiting_browser_authorize",
            }
        try:
            body = err.read().decode("utf-8")
            return json.loads(body)
        except Exception:
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

    # Per **D § D10** (P2-17 closure): refuse to persist a `nats_url`
    # that's plaintext on a non-localhost host. Delegates to the single
    # shared client guard (`assert_encrypted_or_localhost`) so persist-
    # time and connect-time policy can never drift — it accepts `wss://`
    # and `tls://`, rejects `ws://` / `nats://` off localhost. A
    # compromised registration endpoint could otherwise inject
    # `ws://attacker.com` and trick the next connect into a plaintext,
    # attacker-controlled session.
    assert isinstance(nats_url, str)  # narrowed above
    try:
        assert_encrypted_or_localhost(nats_url)
    except ValueError as err:
        raise OSError(
            f"registration response had a plaintext nats_url ({nats_url}); "
            "refusing to persist. Verify your KLODI_API_URL.",
        ) from err

    klodi_home = _klodi_home()
    klodi_home.mkdir(parents=True, exist_ok=True)
    try:
        os.chmod(klodi_home, 0o700)
    except OSError:
        pass  # fs may not support chmod — not fatal

    # `klodi_secret_write` opens with mode at creation time and renames
    # atomically — closes the TOCTOU window the prior write+chmod pair
    # opened (P1-8 in the 2026-04-26 multi-lens review). Creds first so
    # a partial state (config without creds) can't leak through if we
    # are interrupted mid-write.
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

    # Auto-trust the register-response CA (card
    # auto-trust-nats-ca-from-register): `nats_ca` is OPTIONAL — it is not
    # in the required-field loop above, so its absence never fails
    # registration. The shared helper skips a non-string / empty /
    # non-PEM-shaped value and never raises, and an omission on a later
    # re-register does NOT delete the persisted file ("no update" ≠
    # "revoke"). A fresh value overwrites → re-register is the CA-rotation
    # path.
    nats_ca = result.get("nats_ca")
    if isinstance(nats_ca, str):
        persist_nats_ca(klodi_home, nats_ca)

    # Local imports: avoid a top-level cycle with wake_pump_control and
    # client, both of which transitively pull from local_tools (which
    # imports this module's helpers in some test paths).
    from .client import close_client
    from .wake_pump_control import start_wake_pump, stop_wake_pump

    # Drain any stale pump and tear down the request-side singleton so
    # the next start_wake_pump() reconstructs KlodiClient against the
    # creds we just persisted. Without close_client(), get_client()
    # returns the existing instance whose NATS session was bound to the
    # pre-repair user — every klodi_* tool call returns UNAUTHORIZED
    # while klodi_setup_status reports phase=ready (creds files exist
    # on disk, but the in-process connection is stale).
    #
    # Failure here is logged but does not roll back the persist — wake
    # pump and connection refresh are observability/transport, not
    # credentials.
    try:
        stop_wake_pump()
        close_client()
        start_wake_pump()
    except Exception as err:  # noqa: BLE001 — never block the persist
        log.warning("register_client_refresh_failed error=%s", err)


def _wake_agent(result: dict[str, Any]) -> None:
    """Best-effort wake: inject a system message into the active
    Hermes session. Returns False silently when no CLI reference is
    available (e.g. gateway-only invocation) — the agent picks up the
    result on its next turn by calling klodi_setup_status."""
    ctx = _CTX
    if ctx is None:
        return
    inject = getattr(ctx, "inject_message", None)
    if inject is None:
        return
    status = result.get("status")
    if status == "registered" or status == "completed":
        handle = result.get("handle")
        message = (
            f"klodi registration completed as @{handle}."
            " Wake events will start arriving over NATS automatically."
            " Call klodi_setup_status to verify phase=ready."
        )
    elif status == "timeout":
        message = (
            "klodi registration session timed out after 10 minutes."
            " Run klodi_register again to start a fresh session."
        )
    else:
        message = (
            f"klodi registration did not complete: {status}."
            f" Raw response: {json.dumps(result)[:200]}"
        )
    try:
        inject(message, role="system")
    except Exception as err:  # noqa: BLE001 — wake is best-effort
        log.warning("register_wake_inject_failed error=%s", err)


def _is_uuid(value: str) -> bool:
    try:
        uuid.UUID(value)
        return True
    except ValueError:
        return False


# ── Registration ─────────────────────────────────────────────────────

def register_register_tools(ctx: Any) -> int:
    """Wire klodi_register + klodi_register_poll onto the Hermes tool
    surface. Called from __init__.py after the MCP tools are
    registered. Returns the number of tools registered."""
    bind_ctx(ctx)

    ctx.register_tool(
        name="klodi_register",
        toolset="klodi",
        schema={
            "name": "klodi_register",
            "description": (
                "Start the browser-based registration on the klodi"
                " marketplace. Returns an auth URL for the user to"
                " open. The adapter polls the session in the"
                " background for up to 10 minutes and wakes the agent"
                " when registration completes, expires, or times out"
                " — no agent-side polling loop required."
            ),
            "parameters": {
                "type": "object",
                "properties": {},
                "additionalProperties": False,
            },
        },
        handler=handle_register,
        check_fn=None,
        requires_env=[],
        is_async=False,
        description="Start browser-based klodi registration.",
        emoji="🔑",
    )

    ctx.register_tool(
        name="klodi_register_poll",
        toolset="klodi",
        schema={
            "name": "klodi_register_poll",
            "description": (
                "Manual fallback: check the current state of a"
                " registration session. klodi_register already starts"
                " a background poll that wakes the agent on"
                " completion — only call this if that wake hasn't"
                " arrived and you suspect the plugin was reloaded"
                " mid-flow."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "session_id": {
                        "type": "string",
                        "description": (
                            "UUID returned by klodi_register."
                        ),
                    },
                },
                "required": ["session_id"],
                "additionalProperties": False,
            },
        },
        handler=handle_register_poll,
        check_fn=None,
        requires_env=[],
        is_async=False,
        description="Manually poll the klodi registration session.",
        emoji="⏲️",
    )
    return 2


__all__ = [
    "bind_ctx",
    "handle_register",
    "handle_register_poll",
    "register_register_tools",
]
