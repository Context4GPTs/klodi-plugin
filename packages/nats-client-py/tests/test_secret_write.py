"""Adversarial tests for ``klodi_secret_write``.

Closes finding P1-8 from
``docs/reviews/2026-04-26-klodi-plugin-multi-lens-review.md``.

Threat model: existing register paths do ``write(path, body)`` then
``chmod(path, 0o600)`` — that leaves a window where the secret is
world-readable. The helper must open with the secure mode set at
``open(2)`` time and use a temp + atomic rename so first-write,
re-registration, and any failure mid-write all leave only files
that were never readable to other users.

Filesystem isolation comes from ``tmp_path``. ``os.open`` /
``os.write`` / ``os.fsync`` are deliberately not mocked — the real
syscall behavior is what's under test. ``monkeypatch`` is only used
to simulate a rename failure (test 4).
"""

from __future__ import annotations

import os
import stat
from pathlib import Path

import pytest

from klodi_nats_client.secret_write import DEFAULT_MODE, klodi_secret_write


def _mode(path: Path) -> int:
    """Return the permission bits of ``path`` as an int (e.g. 0o600)."""
    return stat.S_IMODE(path.stat().st_mode)


# ── 1. First write produces a file at mode 0o600 ──────────────────────


def test_first_write_creates_file_at_mode_0o600(tmp_path: Path) -> None:
    target = tmp_path / "creds.txt"

    returned = klodi_secret_write(target, "secret-token")

    assert returned == target
    assert target.exists()
    assert _mode(target) == 0o600
    assert target.read_text() == "secret-token"
    # No leftover temp.
    assert not (tmp_path / "creds.txt.tmp").exists()


# ── 2. Overwrite of a wide-mode file ends at 0o600 with new contents ──


def test_overwrite_of_world_readable_file_ends_at_0o600(tmp_path: Path) -> None:
    """Re-registration scenario: a prior run (or attacker) left a
    0o644 file on disk. After ``klodi_secret_write`` returns, the
    final file must be 0o600 and contain the new payload — the
    rename installs a fresh inode, it does not inherit the old
    mode."""
    target = tmp_path / "creds.txt"
    target.write_text("OLD-CONTENTS")
    os.chmod(target, 0o644)
    assert _mode(target) == 0o644  # sanity

    klodi_secret_write(target, "NEW-CONTENTS")

    assert _mode(target) == 0o600
    assert target.read_text() == "NEW-CONTENTS"


# ── 3. umask(0) cannot widen the resulting file ───────────────────────


def test_umask_zero_does_not_widen_file_mode(tmp_path: Path) -> None:
    """The whole point of opening with the mode set at create-time is
    that the kernel can't apply a wider umask afterwards. Force the
    worst-case umask (0 — every bit allowed) and prove the file is
    still 0o600."""
    target = tmp_path / "creds.txt"
    prev_umask = os.umask(0)
    try:
        klodi_secret_write(target, "secret-under-permissive-umask")
    finally:
        os.umask(prev_umask)

    assert _mode(target) == 0o600
    assert target.read_text() == "secret-under-permissive-umask"


# ── 4. Rename failure leaves no .tmp and no partial target ────────────


def test_rename_failure_cleans_up_temp_and_leaves_no_target(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Simulate a crash at the atomic-rename step. The contract:
    (a) exception propagates,
    (b) no ``.tmp`` is left behind for an attacker to read,
    (c) the target either doesn't exist or is unchanged.
    Then prove that after restoring normal behavior the helper
    still works — i.e. failure didn't poison future writes."""
    target = tmp_path / "creds.txt"
    tmp_sibling = tmp_path / "creds.txt.tmp"

    def _boom(src: str | os.PathLike[str], dst: str | os.PathLike[str]) -> None:
        raise OSError("simulated rename failure")

    monkeypatch.setattr(os, "replace", _boom)

    with pytest.raises(OSError, match="simulated rename failure"):
        klodi_secret_write(target, "should-not-survive")

    assert not tmp_sibling.exists(), "temp file leaked after rename failure"
    assert not target.exists(), "target should not exist after rename failure"

    # Restore normal os.replace and confirm the next call succeeds —
    # i.e. no stale state poisoned the next write (e.g. an O_EXCL
    # collision on a leftover temp).
    monkeypatch.undo()
    klodi_secret_write(target, "recovered")
    assert _mode(target) == 0o600
    assert target.read_text() == "recovered"
    assert not tmp_sibling.exists()


# ── 5. Explicit mode override ─────────────────────────────────────────


def test_mode_override_for_non_secret_config_files(tmp_path: Path) -> None:
    """Non-secret config (e.g. group-readable) should be supported
    via the ``mode=`` argument without bypassing the same atomic
    write path."""
    target = tmp_path / "config.json"

    klodi_secret_write(target, "{\"k\":\"v\"}", mode=0o640)

    assert _mode(target) == 0o640
    assert target.read_text() == "{\"k\":\"v\"}"


def test_default_mode_constant_is_0o600() -> None:
    """Defensive: the public constant must stay at the secret-default
    so callers that import it for diffing can't be silently widened."""
    assert DEFAULT_MODE == 0o600


# ── 6. Bytes payloads are written byte-exact ──────────────────────────


def test_bytes_payload_is_written_verbatim(tmp_path: Path) -> None:
    """Binary creds must round-trip exactly — no implicit utf-8
    decode, no newline translation, no truncation at NUL bytes."""
    target = tmp_path / "binary.bin"
    payload = bytes(range(256))  # 0x00..0xFF — invalid UTF-8 on purpose

    klodi_secret_write(target, payload)

    assert target.read_bytes() == payload
    assert _mode(target) == 0o600


def test_str_payload_is_utf8_encoded(tmp_path: Path) -> None:
    """Counterpart to the bytes test: str inputs are encoded as
    utf-8, which is the only sane default for textual creds and
    json bodies."""
    target = tmp_path / "text.txt"
    payload = "héllo-✓"

    klodi_secret_write(target, payload)

    assert target.read_bytes() == payload.encode("utf-8")
    assert _mode(target) == 0o600
