"""INVARIANT GUARD — certificate/hostname verification is never disabled (py).

Card: support-tls-nats-transport-with-private-ca-trust — the CORE security
invariant. The one real risk of this change is someone disabling cert
verification to "make it connect". This guard fails the build if any
insecure TLS toggle appears in the Python TLS connect path or the
credential-persist code, or if an env var / flag can turn verification off.

This test is GREEN today (no TLS code disables verification yet). It is a
RATCHET, not a RED driver: it must stay green as the ``tls://`` + CA-trust
code lands. The moment GREEN work introduces ``ssl.CERT_NONE`` /
``check_hostname=False`` / ``verify=False`` / a ``KLODI_NATS_INSECURE``-style
env opt-out, this goes RED.

``KLODI_NATS_CA_FILE`` (the sanctioned override) selects *which* CA to
trust — never *whether* to verify — so a plain ``*_CA_FILE`` reference is
allowed; only verification-OFF toggles are forbidden.

The forbidden needles are assembled from fragments at runtime so this test
file does not itself contain the literal tokens it forbids (a repo-wide
grep gate must not trip on its own guard).

QA-owned. NEVER weaken.
"""

from __future__ import annotations

from pathlib import Path

_SRC = Path(__file__).resolve().parent.parent / "src" / "klodi_nats_client"


def _repo_root() -> Path:
    """Walk up to the polyglot-monorepo root (the dir holding
    ``pnpm-workspace.yaml``) — robust to worktree depth, unlike a fixed
    ``parents[n]`` index."""
    for parent in Path(__file__).resolve().parents:
        if (parent / "pnpm-workspace.yaml").exists():
            return parent
    raise RuntimeError("pnpm-workspace.yaml not found above this test")


_REPO_ROOT = _repo_root()

# Files that build the TLS connect context or persist the nats_url.
_SCANNED_FILES = [
    _SRC / "client.py",
    _SRC / "config.py",
    _REPO_ROOT / "adapters" / "hermes" / "src" / "klodi_hermes" / "register.py",
    _REPO_ROOT / "adapters" / "nanobot" / "nanobot_local_tools.py",
]

# Assembled from fragments so this file carries no literal forbidden token.
_CERT_NONE = "CERT_" + "NONE"
_CERT_OPTIONAL = "CERT_" + "OPTIONAL"
_CHECK_HOSTNAME_OFF = "check_hostname=" + "False"
_VERIFY_OFF = "verify=" + "False"
_VERIFY_MODE_NONE = "verify_mode=ssl." + _CERT_NONE

# Env-var / flag names that would smell of a verification opt-out.
_ENV_TOGGLE_FRAGMENTS = [
    "INSEC" + "URE",
    "NO_" + "VERIFY",
    "SKIP_" + "VERIFY",
    "DISABLE_" + "TLS",
    "ALLOW_" + "PLAINTEXT",
    "NO_" + "TLS",
]


def _normalized(path: Path) -> str:
    """Collapse whitespace around ``=`` so ``x = False`` and ``x=False``
    both match the assembled needles."""
    text = path.read_text(encoding="utf-8")
    # Drop spaces immediately around '=' (assignment or kwarg).
    return text.replace(" =", "=").replace("= ", "=")


def test_scanned_files_exist() -> None:
    """Fail loudly if a scan target moved — a silently-empty scan would
    make this guard vacuously pass."""
    missing = [str(p) for p in _SCANNED_FILES if not p.is_file()]
    assert not missing, f"scan targets missing (update the guard): {missing}"


def test_no_insecure_ssl_context_toggle() -> None:
    for path in _SCANNED_FILES:
        body = _normalized(path)
        for needle in (
            _CERT_NONE,
            _CERT_OPTIONAL,
            _CHECK_HOSTNAME_OFF,
            _VERIFY_OFF,
            _VERIFY_MODE_NONE,
        ):
            assert needle not in body, (
                f"{path.name} disables/weakens TLS verification "
                f"(found {needle!r}) — forbidden by the card invariant"
            )


def test_no_env_var_can_disable_verification() -> None:
    for path in _SCANNED_FILES:
        body = path.read_text(encoding="utf-8")
        for frag in _ENV_TOGGLE_FRAGMENTS:
            assert frag not in body, (
                f"{path.name} references a verification-opt-out-shaped token "
                f"({frag!r}) — no flag may turn cert verification off"
            )
