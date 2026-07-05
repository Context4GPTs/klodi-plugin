"""klodi-nats-client — Python port of @klodi/nats-client (TS).

Public surface mirrors the TS package. Adapters import from this single
entry point. Subjects + JSON Schemas come from
``klodi-plugin/packages/tool-catalog/dist/schemas.json`` bundled into
the wheel.
"""

from __future__ import annotations

from klodi_nats_client.backoff import (
    BackoffPolicy,
    DEFAULT_BASE_SECONDS,
    DEFAULT_CAP_SECONDS,
    DEFAULT_JITTER_RATIO,
    DEFAULT_MULTIPLIER,
    compute_backoff_seconds,
)
from klodi_nats_client.catalog import (
    TOOL_NAMES,
    TOOL_SCHEMAS,
    TOOL_SUBJECTS,
    ToolName,
    ToolSchema,
)
from klodi_nats_client.client import (
    DEFAULT_REQUEST_TIMEOUT_SECONDS,
    WHOAMI_PROBE_TIMEOUT_SECONDS,
    ErrorCallback,
    ErrorContext,
    KlodiClient,
    KlodiRequestError,
)
from klodi_nats_client.config import (
    ConfigInvalidError,
    ConfigNotFoundError,
    CredsNotFoundError,
    KlodiConfig,
    assert_tls_or_localhost,
    is_localhost,
    load_config,
    load_creds,
)
from klodi_nats_client.constants import (
    KLODI_DEFAULT_API_URL,
    KLODI_DEFAULT_NATS_URL,
    KLODI_NATS_CA_PEM,
    MAX_CHANNEL_MESSAGE_CHARS,
)
from klodi_nats_client.tls import (
    CaTrustError,
    build_tls_context,
    persist_nats_ca,
)
from klodi_nats_client.consumers import (
    ActiveSubscription,
    ChannelHandler,
    KlodiSetupError,
    NotificationHandler,
)
from klodi_nats_client.local_tools import (
    CHANNEL_MESSAGE_PARAMS,
    MATCH_FEEDBACK_PARAMS,
)
from klodi_nats_client.metrics import ClientMetrics
from klodi_nats_client.paths import (
    default_api_url,
    default_config_path,
    default_creds_path,
    default_klodi_home,
    default_nats_ca_path,
    nats_ca_path,
)
from klodi_nats_client.events import (
    ChannelLifecycleEvent,
    ChannelMessageEvent,
    CommentPostedEvent,
    EventId,
    ListingStateEvent,
    ListingStatusChangedEvent,
    ListingSummary,
    NotificationEvent,
    OfferProposedEvent,
    OfferRespondedEvent,
    SearchMatchEvent,
    TransactionStateEvent,
)
from klodi_nats_client.publish import (
    PublishChannelResult,
    PublishMatchFeedbackResult,
    publish_match_feedback,
)
from klodi_nats_client.wake_pump import (
    OnChannelEvent,
    OnNotification,
    WakePump,
    WakePumpClient,
    WakePumpHealth,
    create_wake_pump,
)

__all__ = [
    "ActiveSubscription",
    "BackoffPolicy",
    "CHANNEL_MESSAGE_PARAMS",
    "ChannelHandler",
    "CaTrustError",
    "ChannelLifecycleEvent",
    "ChannelMessageEvent",
    "ClientMetrics",
    "CommentPostedEvent",
    "ConfigInvalidError",
    "ConfigNotFoundError",
    "CredsNotFoundError",
    "DEFAULT_BASE_SECONDS",
    "DEFAULT_CAP_SECONDS",
    "DEFAULT_JITTER_RATIO",
    "DEFAULT_MULTIPLIER",
    "DEFAULT_REQUEST_TIMEOUT_SECONDS",
    "ErrorCallback",
    "ErrorContext",
    "EventId",
    "KLODI_DEFAULT_API_URL",
    "KLODI_DEFAULT_NATS_URL",
    "KLODI_NATS_CA_PEM",
    "KlodiClient",
    "KlodiConfig",
    "KlodiRequestError",
    "KlodiSetupError",
    "ListingStateEvent",
    "ListingStatusChangedEvent",
    "ListingSummary",
    "MATCH_FEEDBACK_PARAMS",
    "MAX_CHANNEL_MESSAGE_CHARS",
    "NotificationEvent",
    "NotificationHandler",
    "OnChannelEvent",
    "OnNotification",
    "OfferProposedEvent",
    "OfferRespondedEvent",
    "PublishChannelResult",
    "PublishMatchFeedbackResult",
    "SearchMatchEvent",
    "TOOL_NAMES",
    "TOOL_SCHEMAS",
    "TOOL_SUBJECTS",
    "ToolName",
    "ToolSchema",
    "TransactionStateEvent",
    "WHOAMI_PROBE_TIMEOUT_SECONDS",
    "WakePump",
    "WakePumpClient",
    "WakePumpHealth",
    "assert_tls_or_localhost",
    "build_tls_context",
    "compute_backoff_seconds",
    "create_wake_pump",
    "default_api_url",
    "default_config_path",
    "default_creds_path",
    "default_klodi_home",
    "default_nats_ca_path",
    "is_localhost",
    "load_config",
    "load_creds",
    "nats_ca_path",
    "persist_nats_ca",
    "publish_match_feedback",
]
