"""Unit tests for ``klodi_nats_client.paths.default_klodi_home`` (P2-14 Py).

Covers the four resolution branches: macOS path, Linux path with
``XDG_CONFIG_HOME``, Linux path without it, and the ``KLODI_HOME``
override. Each test patches ``sys.platform`` and the relevant env vars
so the fixture state does not leak across tests.
"""

from __future__ import annotations

import os
import sys
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest

from klodi_nats_client.paths import (
    default_config_path,
    default_creds_path,
    default_klodi_home,
)


@pytest.fixture
def env_isolated(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    """Isolate the env vars this module reads so tests don't leak."""
    monkeypatch.delenv("KLODI_HOME", raising=False)
    monkeypatch.delenv("XDG_CONFIG_HOME", raising=False)
    monkeypatch.delenv("APPDATA", raising=False)
    yield


def test_klodi_home_env_override_wins(
    env_isolated: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("KLODI_HOME", "/tmp/explicit-klodi-home")
    # macOS-style XDG also set — env override must still win.
    monkeypatch.setenv("XDG_CONFIG_HOME", "/should/not/be/used")
    assert default_klodi_home() == Path("/tmp/explicit-klodi-home")


def test_macos_default_path(
    env_isolated: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(sys, "platform", "darwin")
    monkeypatch.setattr(Path, "home", classmethod(lambda _cls: Path("/Users/alice")))
    assert default_klodi_home() == Path(
        "/Users/alice/Library/Application Support/klodi"
    )


def test_linux_with_xdg_config_home(
    env_isolated: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(sys, "platform", "linux")
    monkeypatch.setenv("XDG_CONFIG_HOME", "/home/alice/.local/config")
    assert default_klodi_home() == Path("/home/alice/.local/config/klodi")


def test_linux_without_xdg_falls_back_to_dot_config(
    env_isolated: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(sys, "platform", "linux")
    monkeypatch.setattr(Path, "home", classmethod(lambda _cls: Path("/home/alice")))
    assert default_klodi_home() == Path("/home/alice/.config/klodi")


def test_default_creds_and_config_paths_relative_to_home(
    env_isolated: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("KLODI_HOME", "/var/state/klodi-test")
    assert default_creds_path() == Path("/var/state/klodi-test/nats.creds")
    assert default_config_path() == Path("/var/state/klodi-test/config.json")
