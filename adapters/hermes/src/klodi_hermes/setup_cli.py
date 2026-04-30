"""klodi-hermes-setup — post-install bootstrap for the klodi Hermes adapter.

Run after ``pip install klodi-hermes``:

    ~/git/hermes-agent/venv/bin/pip install klodi-hermes
    ~/git/hermes-agent/venv/bin/klodi-hermes-setup
    hermes plugins enable klodi

Hermes ≥ 0.11.0 discovers plugins via the ``hermes_agent.plugins``
entry-points group declared in our pyproject.toml, so the wheel install
alone is enough to make ``klodi_*`` tools appear after
``hermes plugins enable klodi``. This CLI handles the parts the wheel
install can't, namely the per-user filesystem state.

What ``klodi-hermes-setup`` does:

  1. Resolves ``${KLODI_HOME}`` (env or platform default) and creates
     it at 0700.
  2. Seeds the bundled skill into ``${KLODI_HOME}/skill/`` so the
     agent reads SKILL.md and references/ from a stable per-user path.
  3. Copies the bundled skill into ``${HERMES_HOME}/skills/klodi/`` so
     the agent advertises it in the system-prompt's
     ``<available_skills>`` index and ``hermes skills list`` shows it.
     ``ctx.register_skill`` alone is not enough — the SDK exposes the
     plugin-namespaced ``klodi:klodi`` form via ``skill_view`` only,
     and the model has no way to discover that namespace without an
     entry in the flat skills tree. Opt out with
     ``--no-hermes-skill-index`` when the namespaced form must be the
     sole loadable surface.
  4. **Optional** (``--with-plugin-dir``): writes a discovery stub at
     ``${HERMES_HOME}/plugins/klodi/`` with a copy of ``plugin.yaml``
     and a thin ``__init__.py`` that re-exports ``register`` from the
     installed wheel. Use this only when you want
     ``hermes plugins list`` to show the rich manifest fields
     (description, version, provides_tools); entry-point discovery
     produces a name-only row otherwise. The stub is harmless if both
     paths coexist — Hermes' last-write-wins resolves to the entry
     point, but the directory's plugin.yaml is what ``hermes plugins
     list`` reads for metadata.

Registration (``klodi_register``) is NOT performed here. It runs from
inside the agent — the user asks the agent to call ``klodi_register``,
which kicks off browser-based Auth0 sign-up and persists nats.creds +
config.json on success.
"""

from __future__ import annotations

import argparse
import logging
import os
import shutil
import sys
from pathlib import Path

from .hermes_installer import (
    EXIT_OK,
    EXIT_USAGE,
    default_klodi_home,
    ensure_klodi_home,
    seed_skill_dir,
    validate_host_slug,
)


log = logging.getLogger("klodi_hermes.setup")


# The bundled skill ships at ${plugin_dir}/skills/klodi/ via
# scripts/copy-skill.py — that path is also what __init__.py registers
# with Hermes. Seed the canonical bundle into ${klodi_home}/skill/ so
# the agent can read SKILL.md and references/ from a stable per-user path
# regardless of host (per Decision 2 of the 0012 first-pass review).
_PACKAGE_DIR = Path(__file__).resolve().parent
_BUNDLED_SKILL_DIR = _PACKAGE_DIR / "skills" / "klodi"
_BUNDLED_PLUGIN_YAML = _PACKAGE_DIR / "plugin.yaml"

# Plugin name as Hermes will show it in `hermes plugins list`. Drives
# the directory name under ${HERMES_HOME}/plugins/. Must match
# plugin.yaml's `name:` field.
_PLUGIN_NAME = "klodi"

# Marker we drop in the auto-generated __init__.py so subsequent runs
# can recognise (and harmlessly overwrite) their own output. If a user
# has manually customised the file the marker is missing and we warn
# before overwriting.
_STUB_MARKER = "# klodi-hermes-setup: auto-generated stub — do not edit"


def default_hermes_home() -> Path:
    """Resolve ``${HERMES_HOME}``: env var first, then ``~/.hermes``.

    Mirrors the convention used by hermes-agent itself and by every
    third-party plugin's installer (cloudflare, otel, etc.). Hermes
    walks ``${HERMES_HOME}/plugins/`` for plugin discovery.
    """
    env = os.environ.get("HERMES_HOME")
    if env:
        return Path(env)
    return Path.home() / ".hermes"


def install_hermes_skill_index(
    hermes_home: Path,
    source: Path,
    *,
    reseed: bool = True,
) -> Path | None:
    """Copy the bundled klodi skill into ``${HERMES_HOME}/skills/klodi/``.

    Why this is necessary even though ``__init__.py`` already calls
    ``ctx.register_skill("klodi", ...)``: the SDK's ``register_skill``
    namespaces the skill as ``klodi:klodi`` and exposes it via
    ``skill_view`` only — it does NOT enter the flat
    ``${HERMES_HOME}/skills/`` tree, is NOT advertised in the system
    prompt's ``<available_skills>`` index (Hermes builds that block
    from a filesystem scan in ``hermes/agent/prompt_builder.py``), and
    is NOT shown by ``hermes skills list`` (same scan, in
    ``hermes/tools/skills_tool.py``). The model therefore has no way
    to discover that ``klodi:klodi`` exists and falls back to the raw
    tool surface. The Hermes plugin guide documents the legacy copy
    pattern as the way to surface a plugin skill in both the system
    prompt's index and the user-facing list.

    Reseed semantics mirror :func:`hermes_installer.seed_skill_dir`
    (P3-19 Option A): ``reseed=True`` (default) overwrites with a
    warning, ``reseed=False`` refuses to clobber and returns ``None``
    so the caller can surface a user-facing error.

    Returns the install target on success, ``None`` when the source is
    missing or reseed was refused.
    """
    if not source.is_dir():
        log.warning(
            "klodi_skill_source_missing path=%s — Hermes skill index"
            " not installed. The agent's <available_skills> will not"
            " list klodi until reinstall.",
            source,
        )
        return None
    target = hermes_home / "skills" / _PLUGIN_NAME
    if target.exists():
        if not reseed:
            log.error(
                "[reseed] target exists at %s — pass --reseed (default) to"
                " overwrite, or remove the directory manually. Skill index"
                " left untouched.",
                target,
            )
            return None
        log.warning(
            "[reseed] removing prior %s (use --no-reseed to keep existing)",
            target,
        )
        shutil.rmtree(target)
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copytree(source, target)
    log.info("klodi_hermes_skill_index_installed target=%s", target)
    return target


def install_plugin_dir(hermes_home: Path) -> Path:
    """Write a metadata stub at ``${HERMES_HOME}/plugins/klodi/``.

    Optional. Hermes ≥ 0.11.0 finds the plugin via the
    ``hermes_agent.plugins`` entry-point group, so the wheel install
    alone is enough for tool registration. This stub exists so that
    ``hermes plugins list`` shows the rich manifest fields
    (description, version, provides_tools) — entry-point plugins get
    a name-only row otherwise.

    Two files are written:

    * ``__init__.py`` — re-exports ``register`` (and ``shutdown``)
      from the installed ``klodi_hermes`` package. The hermes-agent
      venv that Hermes itself runs in must be the same venv where
      ``klodi-hermes`` was pip-installed; otherwise this import fails.
    * ``plugin.yaml`` — a verbatim copy of the wheel's bundled
      ``plugin.yaml``.

    Idempotent. Overwrites stubs we authored (recognised by the marker
    on the first line of ``__init__.py``); warns before overwriting
    user-customised files.
    """
    plugin_dir = hermes_home / "plugins" / _PLUGIN_NAME
    plugin_dir.mkdir(parents=True, exist_ok=True)

    init_py = plugin_dir / "__init__.py"
    if init_py.exists():
        first_line = init_py.read_text(encoding="utf-8").splitlines()[:1]
        if not first_line or _STUB_MARKER not in first_line[0]:
            log.warning(
                "klodi_plugin_dir_overwriting_user_init path=%s — the file"
                " was not created by klodi-hermes-setup. Existing content"
                " will be replaced.",
                init_py,
            )

    init_py.write_text(
        f"{_STUB_MARKER}\n"
        '"""Hermes plugin entry shim for klodi.\n'
        "\n"
        "This file is auto-generated by ``klodi-hermes-setup``. The actual\n"
        "plugin code lives in the ``klodi_hermes`` package installed in\n"
        "this Python environment by ``pip install klodi-hermes``. Do not\n"
        "edit — re-run ``klodi-hermes-setup`` to regenerate.\n"
        '"""\n'
        "from klodi_hermes import register, shutdown\n"
        "\n"
        '__all__ = ["register", "shutdown"]\n',
        encoding="utf-8",
    )

    if not _BUNDLED_PLUGIN_YAML.is_file():
        # The wheel must include plugin.yaml as package data. If it
        # isn't here, the install is broken and there's nothing useful
        # we can do — fail loud so the operator can reinstall.
        raise FileNotFoundError(
            f"plugin.yaml missing at {_BUNDLED_PLUGIN_YAML}. "
            "The klodi_hermes wheel is broken — reinstall via "
            "`pip install --force-reinstall klodi-hermes`."
        )
    shutil.copy2(_BUNDLED_PLUGIN_YAML, plugin_dir / "plugin.yaml")

    log.info(
        "klodi_plugin_dir_installed path=%s name=%s",
        plugin_dir,
        _PLUGIN_NAME,
    )
    return plugin_dir


def _build_parser() -> argparse.ArgumentParser:
    """Construct the ``klodi-hermes-setup`` argparser.

    Extracted from ``main`` so the parser can be exercised in tests
    (default-value sanity checks) without invoking the side-effecting
    install path, and to keep ``main`` under the project's 100-line
    function ceiling.
    """
    parser = argparse.ArgumentParser(
        prog="klodi-hermes-setup",
        description=(
            "Post-install bootstrap for the klodi Hermes adapter. Resolves"
            " ${KLODI_HOME}, seeds the bundled skill into ${KLODI_HOME}/"
            "skill/ AND ${HERMES_HOME}/skills/klodi/ (so the agent finds"
            " it via <available_skills>), and optionally writes a metadata"
            " stub at ${HERMES_HOME}/plugins/klodi/ for richer"
            " `hermes plugins list` output. Plugin discovery itself is"
            " automatic via the hermes_agent.plugins entry-point group."
            " Registration (klodi_register) runs from inside the agent —"
            " this CLI does NOT mint credentials."
        ),
    )
    parser.add_argument(
        "--host-slug",
        default="hermes",
        help=(
            "Identifier the klodi backend uses for operational logs."
            " Validated for shape only — no round-trip happens here."
        ),
    )
    parser.add_argument(
        "--hermes-home",
        default=None,
        help=(
            "Override ${HERMES_HOME} (where Hermes walks plugins/ and"
            " skills/). Defaults to $HERMES_HOME env, then ~/.hermes."
        ),
    )
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
    parser.add_argument(
        "--with-plugin-dir",
        dest="with_plugin_dir",
        action="store_true",
        help=(
            "Also drop a metadata stub at ${HERMES_HOME}/plugins/klodi/"
            " so `hermes plugins list` shows the full manifest. Plugin"
            " discovery works without this; the stub is purely for the"
            " listing UX."
        ),
    )
    parser.set_defaults(with_plugin_dir=False)
    parser.add_argument(
        "--no-hermes-skill-index",
        dest="hermes_skill_index",
        action="store_false",
        help=(
            "Do not copy the bundled skill into ${HERMES_HOME}/skills/"
            "klodi/. Default behaviour installs that copy so the agent"
            " advertises klodi in its <available_skills> index. Skip only"
            " when the plugin-namespaced skill_view(\"klodi:klodi\") form"
            " is intentionally the sole loadable surface."
        ),
    )
    parser.set_defaults(hermes_skill_index=True)
    parser.add_argument(
        "--no-reseed",
        dest="reseed",
        action="store_false",
        help=(
            "Refuse to overwrite either ${KLODI_HOME}/skill/ or"
            " ${HERMES_HOME}/skills/klodi/ if they already exist."
            " Use when SKILL.md has been customised and must not be reset."
            " Without this flag, the installer warns then overwrites."
        ),
    )
    parser.set_defaults(reseed=True)
    return parser


def _print_summary(
    *,
    plugin_dir: Path | None,
    hermes_skill_index: Path | None,
    klodi_home: Path,
    skill_seeded: bool,
) -> None:
    """Render the operator-facing post-install summary on stdout."""
    plugin_dir_line = (
        f"  HERMES_HOME plugin dir : {plugin_dir}  (rich-listing stub)\n"
        if plugin_dir is not None
        else "  HERMES_HOME plugin dir : (skipped — entry-point discovery)\n"
    )
    skill_index_line = (
        f"  HERMES_HOME skill index: {hermes_skill_index}\n"
        if hermes_skill_index is not None
        else "  HERMES_HOME skill index: (skipped — agent will not see"
        " klodi in <available_skills>)\n"
    )
    sys.stdout.write(
        "klodi Hermes adapter setup complete.\n"
        f"{plugin_dir_line}"
        f"{skill_index_line}"
        f"  KLODI_HOME             : {klodi_home}\n"
        f"  skill bundle seeded    : {skill_seeded}\n"
        "\nNext steps:\n"
        "  1. hermes plugins enable klodi          # load the adapter\n"
        "  2. ask the agent to run klodi_register  # browser-based\n"
        "                                            sign-up; the\n"
        "                                            adapter persists\n"
        "                                            nats.creds + config.json\n"
        "                                            on success\n"
        "  3. klodi_setup_status                   # verify phase=ready\n"
    )


def main(argv: list[str] | None = None) -> int:
    args = _build_parser().parse_args(argv)

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )

    try:
        validate_host_slug(args.host_slug)
    except ValueError as err:
        sys.stderr.write(f"error: {err}\n")
        return EXIT_USAGE

    # default_hermes_home is a pure env+path compose — always resolve.
    hermes_home = (
        Path(args.hermes_home) if args.hermes_home else default_hermes_home()
    )
    plugin_dir = install_plugin_dir(hermes_home) if args.with_plugin_dir else None

    klodi_home = (
        Path(args.klodi_home) if args.klodi_home else default_klodi_home()
    )
    ensure_klodi_home(klodi_home)

    skill_source = (
        Path(args.skill_source) if args.skill_source else _BUNDLED_SKILL_DIR
    )
    skill_seeded = seed_skill_dir(klodi_home, skill_source, reseed=args.reseed)

    hermes_skill_index = (
        install_hermes_skill_index(hermes_home, skill_source, reseed=args.reseed)
        if args.hermes_skill_index
        else None
    )

    log.info(
        "klodi_setup_complete plugin_dir=%s klodi_home=%s skill_seeded=%s"
        " hermes_skill_index=%s",
        plugin_dir,
        klodi_home,
        skill_seeded,
        hermes_skill_index,
    )
    _print_summary(
        plugin_dir=plugin_dir,
        hermes_skill_index=hermes_skill_index,
        klodi_home=klodi_home,
        skill_seeded=skill_seeded,
    )
    return EXIT_OK


if __name__ == "__main__":
    raise SystemExit(main())
