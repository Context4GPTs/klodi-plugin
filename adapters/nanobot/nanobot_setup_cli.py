"""klodi-nanobot-setup — one-shot installer.

Post-0012 setup collapses to:

  1. Resolve ${klodi_home} (KLODI_HOME or platform default) and create
     it at 0700.
  2. Best-effort: register the klodi event-bus channel on nanobot.
  3. Print next-step guidance — the user runs ``klodi_register`` from
     inside the agent (browser-based OAuth) and starts the daemon.
"""

from __future__ import annotations

import argparse
import logging
import subprocess
import sys
from pathlib import Path

from nanobot_installer import (
    EXIT_OK,
    EXIT_USAGE,
    default_klodi_home,
    ensure_klodi_home,
    resolve_skill_version,
    seed_skill_dir,
    validate_host_slug,
)


log = logging.getLogger("klodi_nanobot.setup")

# The distribution whose wheel version is the canonical bundle version.
# The bundle ships inside this wheel, so wheel version == bundle version.
_DISTRIBUTION = "klodi-nanobot"


# Per Decision 2 of the 0012 first-pass review, the canonical klodi
# skill bundle is materialized at install time into
# ${klodi_home}/skill/. The bundle ships at ${plugin_dir}/skills/klodi/
# (populated at build time by scripts/copy-skill.py — sibling of
# klodi-plugin/adapters/hermes/scripts/copy-skill.py).
_BUNDLED_SKILL_DIR = Path(__file__).resolve().parent / "skills" / "klodi"


def _register_nanobot_channel(channel: str) -> None:
    """Register the channel on nanobot's event bus.

    Idempotent — nanobot returns non-zero if the channel already
    exists, which is a no-op for our purposes. Missing CLI is a
    soft error (user can register manually).
    """
    try:
        subprocess.run(
            ["nanobot", "events", "register", channel],
            check=True,
            capture_output=True,
            text=True,
            timeout=10,
        )
    except FileNotFoundError:
        log.warning(
            "nanobot_cli_missing — skip channel registration."
            " Install nanobot CLI or register the channel manually."
        )
    except subprocess.CalledProcessError as err:
        log.info(
            "nanobot_channel_register_nonzero code=%d stderr=%s",
            err.returncode,
            err.stderr.strip(),
        )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="klodi-nanobot-setup",
        description="One-shot installer for the klodi nanobot adapter.",
    )
    parser.add_argument("--host-slug", default="nanobot")
    parser.add_argument("--channel", default="klodi")
    parser.add_argument(
        "--klodi-home",
        default=None,
        help="Override ${klodi_home}. Defaults to the XDG/platform value.",
    )
    parser.add_argument(
        "--skill-source",
        default=None,
        help=(
            "Override the bundled skill source directory. Defaults to the"
            " adapter's own ${plugin_dir}/skills/klodi/ tree (populated"
            " at build time by scripts/copy-skill.py)."
        ),
    )
    # --no-reseed is DEPRECATED and inert. Seeding is now version-aware:
    # the canonical bundle always wins when newer, an equal/older bundle
    # is a no-op. The flag is still accepted (so a lagging boot script
    # does not crash) but no longer suppresses an upgrade — a wrong
    # deploy flag must never strand a stale skill. See ADR-0021.
    parser.add_argument(
        "--no-reseed",
        dest="reseed",
        action="store_false",
        help=(
            "DEPRECATED and inert. Seeding is version-aware: the canonical"
            " bundle always wins when newer, an equal/older bundle is a"
            " no-op. Accepted (so a lagging boot script does not crash) but"
            " no longer suppresses an upgrade. Remove it from boot scripts."
        ),
    )
    parser.set_defaults(reseed=True)
    args = parser.parse_args(argv)

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )

    try:
        validate_host_slug(args.host_slug)
    except ValueError as err:
        sys.stderr.write(f"error: {err}\n")
        return EXIT_USAGE

    if not args.reseed:
        log.warning(
            "klodi_no_reseed_deprecated --no-reseed is accepted but inert;"
            " seeding is version-aware and the canonical bundle always wins"
            " when newer. Remove it from boot scripts."
        )

    klodi_home = (
        Path(args.klodi_home) if args.klodi_home else default_klodi_home()
    )
    ensure_klodi_home(klodi_home)
    _register_nanobot_channel(args.channel)

    version = resolve_skill_version(_DISTRIBUTION)
    skill_source = (
        Path(args.skill_source) if args.skill_source else _BUNDLED_SKILL_DIR
    )
    skill_outcome = seed_skill_dir(
        klodi_home, skill_source, version=version, reseed=args.reseed
    )

    sys.stdout.write(
        "klodi nanobot adapter setup complete.\n"
        f"  KLODI_HOME = {klodi_home}\n"
        f"  channel    = {args.channel}\n"
        f"  skill bundle: {skill_outcome} (v{version})\n"
        "\nNext steps:\n"
        "  1. ask the agent to run klodi_register   # browser-based\n"
        "                                            sign-up; persists\n"
        "                                            nats.creds + config.json\n"
        "  2. klodi-nanobot-daemon --channel "
        f"{args.channel}    # run as a long-lived service\n"
    )
    return EXIT_OK


if __name__ == "__main__":
    raise SystemExit(main())
