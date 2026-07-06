"""RED/ratchet — the nats_ca path adds a CA SOURCE, never a verify toggle (py).

The CA auto-trust path — a cross-cutting invariant.

The pre-existing ``test_verification_never_disabled.py`` ratchet scans
``client.py`` / ``config.py`` and the two Python persist sites. It does NOT
scan the new nats_ca code (``tls.py`` gains the persist + level-2 resolve;
``paths.py`` gains the filename source). This guard extends the ratchet to the
NEW surface so the register-CA path can introduce no ``CERT_NONE`` /
``check_hostname=False`` / ``verify=False`` and no env var **or wire field**
that toggles verification off.

Two clauses:
  * verify-off scan (GREEN ratchet) — the new files carry no disabling token.
  * persist-site symmetry (RED driver) — every Python persist site actually
    wires the shared ``persist_nats_ca`` helper, so no adapter silently fails
    to auto-trust (six-adapter symmetry, Python half).

Forbidden needles are assembled from fragments so this file carries no literal
forbidden token (a repo-wide grep gate must not trip on its own guard).

QA-owned — NEVER weaken.
"""

from __future__ import annotations

import io
import tokenize
from pathlib import Path


def _repo_root() -> Path:
    for parent in Path(__file__).resolve().parents:
        if (parent / "pnpm-workspace.yaml").exists():
            return parent
    raise RuntimeError("pnpm-workspace.yaml not found above this test")


_REPO_ROOT = _repo_root()
_SRC = Path(__file__).resolve().parent.parent / "src" / "klodi_nats_client"

# NEW / touched nats_ca code paths (shared resolve+persist + the Python
# adapter persist sites).
_NATS_CA_FILES = [
    _SRC / "tls.py",
    _SRC / "paths.py",
    _REPO_ROOT / "adapters" / "hermes" / "src" / "klodi_hermes" / "register.py",
    _REPO_ROOT / "adapters" / "nanobot" / "nanobot_local_tools.py",
]

# The two Python persist sites that must wire the shared helper.
_PERSIST_SITES = [
    _REPO_ROOT / "adapters" / "hermes" / "src" / "klodi_hermes" / "register.py",
    _REPO_ROOT / "adapters" / "nanobot" / "nanobot_local_tools.py",
]

_CERT_NONE = "CERT_" + "NONE"
_CERT_OPTIONAL = "CERT_" + "OPTIONAL"
_CHECK_HOSTNAME_OFF = "check_hostname=" + "False"
_VERIFY_OFF = "verify=" + "False"
_VERIFY_MODE_NONE = "verify_mode=ssl." + _CERT_NONE
_ENV_TOGGLE_FRAGMENTS = [
    "INSEC" + "URE",
    "NO_" + "VERIFY",
    "SKIP_" + "VERIFY",
    "DISABLE_" + "TLS",
    "ALLOW_" + "PLAINTEXT",
    "NO_" + "TLS",
]


def _code_only(path: Path) -> str:
    """Join the CODE tokens with no separators, dropping comment and string
    (incl. docstring) tokens. So ``tls.py``'s docstring, which legitimately
    *names* the forbidden tokens to document their absence, cannot trip the
    guard — only a real ``ssl.CERT_NONE`` / ``check_hostname=False`` in code
    survives, and it survives as the exact contiguous needle."""
    text = path.read_text(encoding="utf-8")
    drop = {
        tokenize.COMMENT,
        tokenize.STRING,
        tokenize.ENCODING,
        tokenize.NL,
        tokenize.NEWLINE,
        tokenize.INDENT,
        tokenize.DEDENT,
    }
    parts: list[str] = []
    for tok in tokenize.generate_tokens(io.StringIO(text).readline):
        if tok.type not in drop:
            parts.append(tok.string)
    return "".join(parts)


def test_nats_ca_files_exist() -> None:
    missing = [str(p) for p in _NATS_CA_FILES if not p.is_file()]
    assert not missing, f"scan targets missing (update the guard): {missing}"


def test_nats_ca_path_has_no_insecure_toggle() -> None:
    for path in _NATS_CA_FILES:
        body = _code_only(path)
        for needle in (
            _CERT_NONE,
            _CERT_OPTIONAL,
            _CHECK_HOSTNAME_OFF,
            _VERIFY_OFF,
            _VERIFY_MODE_NONE,
        ):
            assert needle not in body, (
                f"{path.name} weakens TLS verification (found {needle!r}) — "
                "the nats_ca path must add a CA source, never a toggle"
            )


def test_nats_ca_path_has_no_verify_off_env_or_field() -> None:
    for path in _NATS_CA_FILES:
        body = path.read_text(encoding="utf-8")
        for frag in _ENV_TOGGLE_FRAGMENTS:
            assert frag not in body, (
                f"{path.name} references a verify-opt-out-shaped token "
                f"({frag!r}) — no env var or wire field may toggle verify off"
            )


def test_every_python_persist_site_wires_the_shared_helper() -> None:
    """[symmetry] Both Python persist sites must call the shared
    ``persist_nats_ca`` — an unwired site silently never auto-trusts."""
    for path in _PERSIST_SITES:
        body = path.read_text(encoding="utf-8")
        assert "persist_nats_ca(" in body, (
            f"{path.name} does not wire persist_nats_ca — that adapter would "
            "never persist the register CA (six-adapter symmetry breach)"
        )
