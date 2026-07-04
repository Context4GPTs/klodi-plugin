"""KlodiClient — single persistent NATS-WS connection per session.

Public surface mirrors ``packages/nats-client-ts/src/client.ts`` 1:1:

  * ``connect()``                — open the WS connection (NKey auth)
  * ``request(subject, body)``   — NATS request/reply for tool calls
  * ``subscribe_notifications``  — durable JetStream consumer + handler
  * ``subscribe_channels``       — durable JetStream consumer + handler
  * ``publish_channel_message``  — direct JetStream publish to a channel
  * ``close()``                  — drain + close
  * ``is_connected``             — liveness probe (property)

The class owns the connection lifecycle and the two consumer
subscriptions. All other behavior (durable creation, dedup, fetch
loop) lives in ``consumers.py`` and ``publish.py``.

Tool-call envelope:
  * Headers: ``X-User-Id``, ``X-Nkey-Public``
  * Body: ``json.dumps(body).encode()``
  * Reply: parsed as JSON; ``{ error, message }`` envelopes raise
    ``KlodiRequestError``.
"""

from __future__ import annotations

import json
import logging
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Any

from nats.aio.client import Client as NATSClient
from nats.errors import NoRespondersError
from nats.js import JetStreamContext

from klodi_nats_client._ws_transport_patch import apply_patch as _apply_ws_patch
from klodi_nats_client.backoff import BackoffPolicy
from klodi_nats_client.config import (
    KlodiConfig,
    assert_encrypted_or_localhost,
    load_config,
    load_creds,
)
from klodi_nats_client.tls import build_tls_context
from klodi_nats_client.consumers import (
    ActiveSubscription,
    ChannelHandler,
    NotificationHandler,
    subscribe_channels,
    subscribe_notifications,
)
from klodi_nats_client.events import (
    ChannelMessageEvent,
    NotificationEvent,
)
from klodi_nats_client.metrics import ClientMetrics, MutableMetrics
from klodi_nats_client.publish import (
    publish_channel_message,
    publish_match_feedback,
)

log = logging.getLogger("klodi_nats_client")

# Default timeout on tool-call request/reply.
DEFAULT_REQUEST_TIMEOUT_SECONDS = 10.0

# Setup-phase / health-probe whoami timeout.
WHOAMI_PROBE_TIMEOUT_SECONDS = 3.0

# Mirror server-side ping_interval in nats-server.conf (TS uses 20s).
WS_PING_INTERVAL_SECONDS = 20

# Exponential reconnect — start at 2s, jitter ±1s, no upper cap on
# attempts (mirrors TS ``maxReconnectAttempts: -1``).
WS_RECONNECT_TIME_WAIT_SECONDS = 2

# Tighter than nats-py's 2s default — gives the server ~10s to accept
# the WebSocket upgrade against Fastly / proxies.
WS_CONNECT_TIMEOUT_SECONDS = 10


ErrorContext = dict[str, Any]
ErrorCallback = Callable[[BaseException, ErrorContext], None]


class KlodiRequestError(RuntimeError):
    """Carries a structured server-side error envelope.

    The marketplace returns ``{error, message}`` for handler-level
    validation failures. Adapters catch and surface it as a tool-result
    error string.
    """

    def __init__(self, envelope: dict[str, Any]) -> None:
        message = envelope.get("message") or envelope.get("error") or ""
        super().__init__(str(message))
        self.code: str = str(envelope.get("error", ""))
        self.details: Any = envelope.get("details")


def _default_error_sink(
    err: BaseException, context: ErrorContext
) -> None:
    """Log to stderr if the adapter didn't supply ``on_error``."""
    log.warning(
        "klodi_client_error error=%s context=%s",
        str(err),
        context,
    )


class KlodiClient:
    """Process-wide NATS-WS client. Created once per session.

    Adapter is responsible for opening on session start and closing on
    session end. A single instance per host process is the supported
    deployment shape — the tool-call surface and the wake-consumer
    surface share one connection.
    """

    def __init__(
        self,
        *,
        creds_path: str,
        config_path: str,
        on_error: ErrorCallback | None = None,
    ) -> None:
        self._creds_path = creds_path
        self._config_path = config_path
        self._on_error: ErrorCallback = on_error or _default_error_sink

        self._nc: NATSClient | None = None
        self._js: JetStreamContext | None = None
        self._config: KlodiConfig | None = None

        self._notifications_sub: ActiveSubscription | None = None
        self._channels_sub: ActiveSubscription | None = None

        # P2-27 — per-client counters surfaced through ``metrics``.
        self._metrics = MutableMetrics()
        # P2-5 — exponential backoff cursor; resets on successful connect.
        self._backoff = BackoffPolicy()

    # ── Metrics ───────────────────────────────────────────────────────

    @property
    def metrics(self) -> ClientMetrics:
        """Read-only snapshot of per-client counters (P2-27).

        Refreshed on every read — callers comparing across snapshots
        should grab a fresh one rather than reusing.
        """
        return self._metrics.snapshot()

    # ── Lifecycle ─────────────────────────────────────────────────────

    async def connect(self) -> None:
        """Open the underlying NATS-WS connection. Idempotent — returns
        the existing connection when called twice.

        P2-5: ``nats-py`` does not expose a per-attempt delay callback,
        so the library's reconnect loop runs at a flat
        ``WS_RECONNECT_TIME_WAIT_SECONDS``. The
        :attr:`_backoff` cursor lives here so subsequent
        external-driven reconnects (e.g. supervisor restart) start
        fresh, and tests can drive deterministic delays via
        :func:`klodi_nats_client.backoff.compute_backoff_seconds`.
        """
        if self._nc is not None and self._nc.is_connected:
            self._backoff.reset()
            return

        # Repair upstream nats-py's WebSocketTransport before any
        # connect attempts. Inert on a ``tls://`` (raw TCP) transport,
        # but still load-bearing on every ``ws://`` connection: without
        # it, long-lived consumers (the wake pump's two JetStream
        # subscriptions) die on the first CLOSE / PING / ERROR frame the
        # WS edge sends — see ``_ws_transport_patch`` for the defect.
        _apply_ws_patch()

        config = self._load_config()
        assert_encrypted_or_localhost(config.nats_url)
        creds = load_creds(self._creds_path)

        # `tls://` → hand nats-py a verifying SSLContext that trusts the
        # private CA (cert + hostname verification stays ON). `None` for
        # `wss://` (nats-py's system-default TLS) and `ws://localhost`.
        # `klodi_home` is the creds-path parent — the persisted register CA
        # (`${KLODI_HOME}/nats-ca.pem`) lives in the same home as the creds,
        # so no upward KLODI_HOME re-resolution happens here (layering).
        tls_ctx = build_tls_context(
            config.nats_url, klodi_home=Path(self._creds_path).parent
        )

        nc = NATSClient()
        await nc.connect(
            servers=config.nats_url,
            user_credentials=str(creds),
            tls=tls_ctx,
            max_reconnect_attempts=-1,
            reconnect_time_wait=WS_RECONNECT_TIME_WAIT_SECONDS,
            ping_interval=WS_PING_INTERVAL_SECONDS,
            connect_timeout=WS_CONNECT_TIMEOUT_SECONDS,
            allow_reconnect=True,
            error_cb=self._async_error_cb,
            reconnected_cb=self._async_reconnected_cb,
        )
        self._nc = nc
        self._js = nc.jetstream()
        self._backoff.reset()

    @property
    def is_connected(self) -> bool:
        """True when the WebSocket connection is established and live."""
        return self._nc is not None and self._nc.is_connected

    async def close(self) -> None:
        """Stop both consumer loops and drain the connection. After
        ``close()`` a fresh ``connect()`` re-establishes everything."""
        if self._notifications_sub is not None:
            await self._notifications_sub.stop()
            self._notifications_sub = None
        if self._channels_sub is not None:
            await self._channels_sub.stop()
            self._channels_sub = None
        if self._nc is not None:
            try:
                await self._nc.drain()
            except BaseException as err:  # noqa: BLE001 — best-effort
                self._on_error(err, {"phase": "drain"})
            self._nc = None
            self._js = None

    # ── Tool calls ────────────────────────────────────────────────────

    async def request(
        self,
        subject: str,
        body: dict[str, Any],
        *,
        timeout: float = DEFAULT_REQUEST_TIMEOUT_SECONDS,
    ) -> dict[str, Any]:
        """Tool-call request/reply.

        Adds ``X-User-Id`` and ``X-Nkey-Public`` headers the marketplace
        uses to resolve the caller. Raises ``KlodiRequestError`` on
        ``{error, message}`` envelopes; raises the underlying exception
        on transport / timeout.
        """
        nc = await self._require_connection()
        config = self._load_config()

        headers = {
            "X-User-Id": config.user_id,
            "X-Nkey-Public": config.nkey_public,
        }
        try:
            msg = await nc.request(
                subject,
                json.dumps(body).encode("utf-8"),
                timeout=timeout,
                headers=headers,
            )
        except NoRespondersError as err:
            raise KlodiRequestError({
                "error": "no_responders",
                "message": (
                    f"No responder for {subject}. The marketplace handler"
                    " may be down."
                ),
            }) from err

        try:
            parsed = json.loads(msg.data.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as err:
            raise KlodiRequestError({
                "error": "malformed_response",
                "message": f"Reply on {subject} was not valid JSON: {err}",
            }) from err

        if (
            isinstance(parsed, dict)
            and isinstance(parsed.get("error"), str)
        ):
            raise KlodiRequestError(parsed)
        if not isinstance(parsed, dict):
            raise KlodiRequestError({
                "error": "malformed_response",
                "message": f"Reply on {subject} was not a JSON object",
            })
        return parsed

    # ── Wake subscriptions ────────────────────────────────────────────

    async def subscribe_notifications(
        self,
        handler: Callable[[NotificationEvent], Awaitable[None]],
    ) -> ActiveSubscription:
        """Attach a handler to the per-user notifications consumer.

        Calling twice replaces the previous handler (the previous loop
        is stopped first). Returns the ``ActiveSubscription`` so the
        caller (typically a ``WakePump``) can manage its own lifecycle.
        """
        await self._require_connection()
        js = self._require_js()
        config = self._load_config()

        if self._notifications_sub is not None:
            await self._notifications_sub.stop()
            self._notifications_sub = None

        self._notifications_sub = await subscribe_notifications(
            js=js,
            user_id=config.user_id,
            handler=handler,
            on_error=lambda err: self._on_error(
                err,
                {"consumer": f"klodi-notifications-{config.user_id}"},
            ),
            metrics=self._metrics,
        )
        return self._notifications_sub

    async def subscribe_channels(
        self,
        handler: Callable[[ChannelMessageEvent], Awaitable[None]],
    ) -> ActiveSubscription:
        """Attach a handler to the per-user channels consumer.

        ``filter_subjects`` is server-managed — the marketplace mutates
        it on channel create/close. New channels appear as new subjects
        in the stream of deliveries.

        Returns the ``ActiveSubscription`` so the caller (typically a
        ``WakePump``) can manage its own lifecycle.
        """
        await self._require_connection()
        js = self._require_js()
        config = self._load_config()

        if self._channels_sub is not None:
            await self._channels_sub.stop()
            self._channels_sub = None

        self._channels_sub = await subscribe_channels(
            js=js,
            user_id=config.user_id,
            handler=handler,
            on_error=lambda err: self._on_error(
                err,
                {"consumer": f"klodi-channels-{config.user_id}"},
            ),
            metrics=self._metrics,
        )
        return self._channels_sub

    # ── Channel publish ──────────────────────────────────────────────

    async def publish_channel_message(
        self,
        channel_id: str,
        body: dict[str, Any],
    ) -> dict[str, int]:
        """Publish a channel message via direct JetStream publish.

        ``body`` requires a ``content`` field. Returns
        ``{"sequence": <int>}`` — the message is now in P2P_CHANNELS
        storage and queued for the recipient's consumer.
        """
        await self._require_connection()
        js = self._require_js()
        config = self._load_config()

        content = body.get("content")
        if not isinstance(content, str):
            raise ValueError(
                "publish_channel_message: body.content must be a string"
            )

        result = await publish_channel_message(
            js=js,
            channel_id=channel_id,
            sender_user_id=config.user_id,
            sender_handle=config.handle,
            content=content,
        )
        return {"sequence": result.sequence}

    async def publish_match_feedback(
        self,
        *,
        search_slug: str,
        listing_id: str,
        outcome: str,
        action_on_match: str | None = None,
    ) -> dict[str, Any]:
        """Publish a standing-search match-feedback verdict (SC8 flywheel).

        Stateless direct JetStream publish to
        ``p2p.v1.searches.match_feedback`` — authorship is the
        authenticated connection identity, so no searcher id rides on the
        wire. Returns ``{"sequence": int, "event_id": str}``.
        """
        await self._require_connection()
        js = self._require_js()
        result = await publish_match_feedback(
            js=js,
            search_slug=search_slug,
            listing_id=listing_id,
            outcome=outcome,
            action_on_match=action_on_match,
        )
        return {"sequence": result.sequence, "event_id": result.event_id}

    # ── Internals ─────────────────────────────────────────────────────

    def _load_config(self) -> KlodiConfig:
        if self._config is None:
            self._config = load_config(self._config_path)
        return self._config

    async def _require_connection(self) -> NATSClient:
        if self._nc is None or not self._nc.is_connected:
            await self.connect()
        if self._nc is None:
            raise RuntimeError(
                "KlodiClient: connection unavailable after connect()"
            )
        return self._nc

    def _require_js(self) -> JetStreamContext:
        if self._js is None:
            raise RuntimeError(
                "KlodiClient: jetstream context unavailable — call"
                " connect() first"
            )
        return self._js

    async def _async_error_cb(self, err: BaseException) -> None:
        """nats-py error callback. Surfaces transport-level events."""
        self._on_error(err, {"phase": "transport"})

    async def _async_reconnected_cb(self) -> None:
        """nats-py reconnect callback — reset the backoff cursor."""
        self._backoff.reset()


__all__ = [
    "DEFAULT_REQUEST_TIMEOUT_SECONDS",
    "ErrorCallback",
    "ErrorContext",
    "KlodiClient",
    "KlodiRequestError",
    "WHOAMI_PROBE_TIMEOUT_SECONDS",
]
