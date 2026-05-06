#!/usr/bin/env python3
"""Vendor klodi-{nats-client,rust-host,logger} into a staged copy of the IronClaw adapter.

Three internal-only crates power every Rust adapter:

  - klodi-nats-client (packages/nats-client-rs/) — wire-level NATS client.
  - klodi-rust-host   (packages/klodi-rust-host/) — forwarder / register
                                                    daemon glue.
  - klodi-logger      (packages/logger-rs/)      — unified KlodiLogger.

None are published to crates.io (`publish = false` on each); each adapter
ships its own copy inlined as a private sub-module so the .crate that
lands on crates.io is fully self-contained.

The staged copy under build/staged/ is what `cargo build` /
`cargo publish` runs against — the source tree under
adapters/ironclaw/ is never modified, so local dev (`cargo check`,
`cargo test`) keeps working against the workspace path-deps.

Layout after staging:

    build/staged/
    ├── Cargo.toml          # path-deps dropped, transitive deps injected
    ├── src/
    │   ├── lib.rs          # auto-generated; declares the three vendored mods
    │   ├── _natsclient/    # vendored from packages/nats-client-rs/src/
    │   ├── _rust_host/     # vendored from packages/klodi-rust-host/src/
    │   ├── _logger/        # vendored from packages/logger-rs/src/
    │   └── bin/            # adapter binaries, with imports rewritten

Operations (per module, in order):
    1.  Stage adapter source (Cargo.toml, src/, README.md) → build/staged/.
    2.  For each vendored module:
        a) Copy <pkg>/src/*.rs → build/staged/src/<mod>/, renaming
           lib.rs → mod.rs.
    3.  Write build/staged/src/lib.rs declaring `pub mod _natsclient;`,
        `pub mod _rust_host;`, `pub mod _logger;` (the bins reach
        vendored types via klodi_ironclaw::_<mod>::*).
    4.  Rewrite imports:
          a) Vendored sources (build/staged/src/_<mod>/*.rs):
                `crate::`            → `super::`
                `klodi_<other>::`    → `super::super::_<other>::`
          b) Adapter lib root (build/staged/src/lib.rs):
                no rewrites (we just wrote it).
          c) Adapter bin sources (build/staged/src/bin/*.rs):
                `klodi_<mod>::` → `klodi_ironclaw::_<mod>::`
    5.  Patch staged Cargo.toml:
        — Drop `klodi-nats-client = { path = ... }` and
          `klodi-rust-host = { path = ... }` from [dependencies].
          (klodi-logger is a transitive dep — never appears here.)
        — Add transitive deps from all three vendored Cargo.tomls that
          the adapter does not already declare.
        — Inject `[workspace]` table so cargo treats the staged dir as
          its own workspace root.
"""

from __future__ import annotations

import re
import shutil
import sys
from dataclasses import dataclass
from pathlib import Path

# tomllib is stdlib in 3.11+. The Makefile picks the best Python on PATH
# (python3.13 / 3.12 / 3.11 → falls back to python3). Direct invocation
# from /usr/bin/python3 (3.10) on macOS Sequoia hits this branch — fail
# loud rather than crash on the missing import below.
if sys.version_info < (3, 11):
    sys.stderr.write(
        "[vendor] requires Python 3.11+ for tomllib (you have "
        f"{sys.version_info.major}.{sys.version_info.minor}).\n"
        "         Run via `make build` (Makefile auto-picks 3.11+) or "
        "invoke explicitly:\n"
        "         /opt/homebrew/bin/python3.13 scripts/vendor.py\n"
    )
    raise SystemExit(2)
import tomllib  # noqa: E402  — guarded import per the version check above

HERE = Path(__file__).resolve().parent.parent
REPO_ROOT = HERE.parent.parent
STAGED = HERE / "build" / "staged"

ADAPTER_SLUG = "ironclaw"
ADAPTER_LIB_NAME = f"klodi_{ADAPTER_SLUG}"

COPY_EXCLUDES = (
    "target",
    "build",
    "__pycache__",
    ".pytest_cache",
    "node_modules",
    ".venv",
)


@dataclass(frozen=True)
class VendoredModule:
    """One internal crate that gets inlined into the published bundle."""
    src_root: Path           # packages/<crate>/src/
    cargo_path: Path         # packages/<crate>/Cargo.toml
    mod_name: str            # _natsclient, _rust_host, _logger
    crate_name: str          # klodi-nats-client, klodi-rust-host, klodi-logger
    crate_ident: str         # klodi_nats_client, klodi_rust_host, klodi_logger


VENDORED_MODULES: list[VendoredModule] = [
    VendoredModule(
        src_root=REPO_ROOT / "packages" / "nats-client-rs" / "src",
        cargo_path=REPO_ROOT / "packages" / "nats-client-rs" / "Cargo.toml",
        mod_name="_natsclient",
        crate_name="klodi-nats-client",
        crate_ident="klodi_nats_client",
    ),
    VendoredModule(
        src_root=REPO_ROOT / "packages" / "klodi-rust-host" / "src",
        cargo_path=REPO_ROOT / "packages" / "klodi-rust-host" / "Cargo.toml",
        mod_name="_rust_host",
        crate_name="klodi-rust-host",
        crate_ident="klodi_rust_host",
    ),
    VendoredModule(
        src_root=REPO_ROOT / "packages" / "logger-rs" / "src",
        cargo_path=REPO_ROOT / "packages" / "logger-rs" / "Cargo.toml",
        mod_name="_logger",
        crate_name="klodi-logger",
        crate_ident="klodi_logger",
    ),
]

# Direct path-deps the adapter declares — drop these from staged
# Cargo.toml. (klodi-logger is a transitive dep and is never listed
# directly, so it isn't in this list.)
DROP_PATH_DEPS = ("klodi-nats-client", "klodi-rust-host")


def should_skip(rel: Path) -> bool:
    return any(part in COPY_EXCLUDES for part in rel.parts)


def stage_adapter() -> None:
    if STAGED.exists():
        shutil.rmtree(STAGED)
    STAGED.mkdir(parents=True)

    for entry in HERE.iterdir():
        if entry == STAGED.parent:
            continue
        if should_skip(entry.relative_to(HERE)):
            continue
        target = STAGED / entry.name
        if entry.is_dir():
            shutil.copytree(
                entry,
                target,
                ignore=shutil.ignore_patterns(*COPY_EXCLUDES),
            )
        else:
            shutil.copy2(entry, target)
    print(f"[vendor] staged adapter at {STAGED}")


def stage_vendored_module(mod: VendoredModule) -> None:
    if not mod.src_root.exists():
        sys.stderr.write(
            f"[vendor] missing source for {mod.crate_name} at {mod.src_root}\n"
        )
        raise SystemExit(1)

    target = STAGED / "src" / mod.mod_name
    target.mkdir(parents=True, exist_ok=True)
    for rs in mod.src_root.glob("*.rs"):
        if rs.name == "lib.rs":
            shutil.copy2(rs, target / "mod.rs")
        else:
            shutil.copy2(rs, target / rs.name)
    print(f"[vendor] copied {mod.crate_name} → src/{mod.mod_name}/")


def stage_generated_catalog() -> None:
    """Inline the codegen'd `tool-catalog/dist/rust-types.rs` into the
    `_natsclient` module.

    Source-tree `_natsclient/catalog.rs` reaches the generated file via
    a relative `#[path = "../../tool-catalog/dist/rust-types.rs"]`
    attribute that resolves correctly only inside the workspace tree.
    Inside the staged copy that path goes nowhere, so we copy the file
    in alongside `catalog.rs` and rewrite the attribute to a local name.
    """
    src = REPO_ROOT / "packages" / "tool-catalog" / "dist" / "rust-types.rs"
    if not src.exists():
        sys.stderr.write(
            f"[vendor] generated catalog missing at {src} — "
            "run `pnpm --filter @klodi/tool-catalog codegen` first.\n"
        )
        raise SystemExit(1)

    dest = STAGED / "src" / "_natsclient" / "generated.rs"
    shutil.copy2(src, dest)

    catalog_rs = STAGED / "src" / "_natsclient" / "catalog.rs"
    text = catalog_rs.read_text(encoding="utf-8")
    # Rewrite the upstream relative path to the staged sibling file.
    # We keep the `#[path]` attribute because dropping it would make
    # `mod generated;` look for src/_natsclient/catalog/generated.rs
    # (Rust's default resolution for non-mod.rs files), not the sibling
    # _natsclient/generated.rs we just placed.
    rewritten = re.sub(
        r'#\[path\s*=\s*"[^"]*tool-catalog/dist/rust-types\.rs"\]',
        '#[path = "generated.rs"]',
        text,
    )
    if rewritten == text:
        sys.stderr.write(
            "[vendor] WARNING: did not find the #[path] attribute in "
            "_natsclient/catalog.rs — was the upstream layout changed?\n"
        )
    catalog_rs.write_text(rewritten, encoding="utf-8")
    print("[vendor] inlined tool-catalog/dist/rust-types.rs → _natsclient/generated.rs")


def write_staged_lib_rs() -> None:
    """The Rust adapters are bin-only (no src/lib.rs in the source tree).
    Publish-time we need a library so the bins can `use klodi_ironclaw::_natsclient::*`
    etc. Generate one that just declares the vendored modules — nothing
    in the source tree depends on a real lib, so this lib stays empty
    aside from the `pub mod` declarations.
    """
    lib_rs = STAGED / "src" / "lib.rs"
    body = (
        "//! Auto-generated by scripts/vendor.py — wires the publish-time\n"
        "//! vendored sub-modules (`_natsclient`, `_rust_host`, `_logger`)\n"
        "//! into a public library surface so the adapter `[[bin]]`s can\n"
        f"//! reach vendored types via `{ADAPTER_LIB_NAME}::_<module>::*`.\n"
        "//!\n"
        "//! The source tree under adapters/ironclaw/src/ has no lib.rs —\n"
        "//! local dev uses the workspace path-deps directly. This file\n"
        "//! exists only inside build/staged/.\n"
        "\n"
    )
    for mod in VENDORED_MODULES:
        body += f"pub mod {mod.mod_name};\n"
    lib_rs.write_text(body, encoding="utf-8")
    print(f"[vendor] wrote staged src/lib.rs ({len(VENDORED_MODULES)} pub mods)")


def cross_module_target(crate_ident: str, prefix: str) -> str:
    """Resolve `klodi_<crate>::` to its sibling vendored mod path under <prefix>::.

    Inside a vendored module, references to a *different* vendored crate
    need to walk up two levels (out of the current `_<self>/` mod, out
    of `src/`) and back down into `_<other>/` — i.e. `super::super::_<other>::`.
    From the bin layer, the same crate is reached via
    `klodi_<adapter>::_<other>::`.
    """
    for mod in VENDORED_MODULES:
        if mod.crate_ident == crate_ident:
            return f"{prefix}{mod.mod_name}::"
    raise KeyError(f"unknown vendored crate ident: {crate_ident}")


def rewrite_vendored() -> int:
    """Rewrite imports inside each `src/_<mod>/*.rs`:

    - `crate::` → `super::` so a vendored sub-module file's references
      to its siblings (other files in the same mod) resolve correctly.
      This is wrong for `mod.rs` if it ever has `crate::` references
      (would point above its own module instead of into it), but in
      practice none of the vendored `lib.rs` files use `crate::` —
      they only declare `pub mod`s and re-exports.
    - `klodi_<other>::` → `crate::_<other>::` so cross-vendored references
      hop through the adapter library root via an absolute path. Using
      `crate::` instead of `super::super::` works uniformly at any
      depth, including inside `mod.rs` (the module root) where
      `super::super::` would walk above the lib root and fail.
    """
    crate_re = re.compile(r"\bcrate::")
    cross_patterns = [
        (re.compile(rf"\b{mod.crate_ident}::"), mod) for mod in VENDORED_MODULES
    ]

    rewritten_files = 0
    for mod in VENDORED_MODULES:
        mod_dir = STAGED / "src" / mod.mod_name
        for rs in mod_dir.glob("*.rs"):
            text = rs.read_text(encoding="utf-8")
            new = crate_re.sub("super::", text)
            for pattern, other in cross_patterns:
                if other is mod:
                    # `klodi_<self>::` inside its own vendored copy already
                    # resolves via `crate::` in source, which the rule above
                    # rewrote to `super::` — skip the cross-mod rewrite to
                    # avoid double-handling.
                    continue
                new = pattern.sub(f"crate::{other.mod_name}::", new)
            if new != text:
                rs.write_text(new, encoding="utf-8")
                rewritten_files += 1
    print(
        f"[vendor] rewrote crate:: + cross-mod imports in "
        f"{rewritten_files} vendored file(s)"
    )
    return rewritten_files


def rewrite_adapter_sources() -> tuple[int, int]:
    """Rewrite imports in the adapter's own (non-vendored) source files:

    - Files under `src/bin/`: `klodi_<crate>::` → `<adapter_lib>::_<mod>::`.
      Bins are independent compilation units — they reach vendored
      modules through the adapter library's public surface.
    - Files under `src/` (other than `_<mod>/` and `bin/`): `klodi_<crate>::`
      → `crate::_<mod>::`. IronClaw's source tree currently has no such
      files, so this branch is dormant for ironclaw but kept to mirror
      the moltis/ironclaw layout that may add helpers later.
    """
    cross_patterns = [
        (re.compile(rf"\b{mod.crate_ident}::"), mod) for mod in VENDORED_MODULES
    ]

    lib_count = 0
    bin_count = 0
    src = STAGED / "src"
    for rs in src.rglob("*.rs"):
        if not rs.is_file():
            continue
        rel = rs.relative_to(src)
        if rel.parts and rel.parts[0] in {mod.mod_name for mod in VENDORED_MODULES}:
            continue
        if rel.name == "lib.rs":
            # We just wrote lib.rs — it has no klodi_* imports to rewrite.
            continue

        text = rs.read_text(encoding="utf-8")
        new = text
        is_bin = rel.parts and rel.parts[0] == "bin"
        for pattern, mod in cross_patterns:
            replacement = (
                f"{ADAPTER_LIB_NAME}::{mod.mod_name}::"
                if is_bin
                else f"crate::{mod.mod_name}::"
            )
            new = pattern.sub(replacement, new)
        if new != text:
            rs.write_text(new, encoding="utf-8")
            if is_bin:
                bin_count += 1
            else:
                lib_count += 1

    print(
        f"[vendor] rewrote {lib_count} adapter lib file(s) "
        f"and {bin_count} bin file(s)"
    )
    return lib_count, bin_count


def shared_dep_lines_to_inject(staged_cargo_text: str) -> list[str]:
    """Walk every vendored crate's [dependencies] block and return TOML
    lines for any dep the adapter doesn't already declare.

    Skips the internal klodi-* deps (they're vendored, not external).
    Does not attempt to merge feature lists for deps that *are* already
    present — adapter-level Cargo.toml is responsible for declaring a
    sufficient feature superset (see the tokio features block in
    adapters/ironclaw/Cargo.toml).
    """
    staged_data = tomllib.loads(staged_cargo_text)
    staged_deps = staged_data.get("dependencies", {}) or {}
    internal = {mod.crate_name for mod in VENDORED_MODULES}

    seen: set[str] = set(staged_deps.keys())
    extra_lines: list[str] = []

    for mod in VENDORED_MODULES:
        shared_data = tomllib.loads(mod.cargo_path.read_text(encoding="utf-8"))
        shared_deps = shared_data.get("dependencies", {}) or {}
        for name, spec in shared_deps.items():
            if name in internal:
                continue
            if name in seen:
                continue
            seen.add(name)
            if isinstance(spec, str):
                extra_lines.append(f'{name} = "{spec}"\n')
            elif isinstance(spec, dict):
                inline = ", ".join(
                    f'{k} = {_toml_value(v)}' for k, v in spec.items()
                )
                extra_lines.append(f"{name} = {{ {inline} }}\n")
    return extra_lines


def _toml_value(v: object) -> str:
    if isinstance(v, str):
        return f'"{v}"'
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, list):
        items = ", ".join(_toml_value(x) for x in v)
        return f"[{items}]"
    raise ValueError(f"unsupported TOML value type: {type(v).__name__}")


def _inject_into_section(text: str, section: str, body: str) -> str:
    """Insert `body` at the end of the `[<section>]` block, just before
    the next `[<section>]` header or end-of-file. Appending at file-end
    is wrong when a downstream section like `[profile.release]` already
    exists — the deps would silently land under that table instead.
    """
    lines = text.splitlines(keepends=True)
    in_section = False
    insert_idx: int | None = None
    for i, line in enumerate(lines):
        stripped = line.strip()
        if stripped == f"[{section}]":
            in_section = True
            continue
        if in_section and stripped.startswith("[") and stripped.endswith("]"):
            insert_idx = i
            break
    if not in_section:
        sys.stderr.write(
            f"[vendor] WARNING: could not find [{section}] in staged Cargo.toml — "
            "appending at end (likely wrong).\n"
        )
        return text.rstrip() + f"\n[{section}]\n{body}"
    if insert_idx is None:
        return text.rstrip() + "\n" + body
    return "".join(lines[:insert_idx]) + body + "".join(lines[insert_idx:])


def patch_cargo() -> None:
    cargo_path = STAGED / "Cargo.toml"
    text = cargo_path.read_text(encoding="utf-8")

    for dep_name in DROP_PATH_DEPS:
        before = text
        text = re.sub(
            rf'^\s*{re.escape(dep_name)}\s*=\s*(?:\{{[^\}}]*\}}|"[^"]*")\s*\n',
            "",
            text,
            flags=re.MULTILINE,
        )
        if text == before:
            sys.stderr.write(
                f"[vendor] WARNING: did not find a {dep_name} dep line "
                "to drop in staged Cargo.toml — was it already removed?\n"
            )

    extra = shared_dep_lines_to_inject(text)
    if extra:
        body = (
            "\n# Vendored from klodi-{nats-client,rust-host,logger} (scripts/vendor.py).\n"
            + "".join(extra)
        )
        text = _inject_into_section(text, "dependencies", body)
        print(
            f"[vendor] injected {len(extra)} transitive dep line(s) "
            "into [dependencies]"
        )

    if "[workspace]" not in text:
        text = text.rstrip() + "\n\n[workspace]\n"

    cargo_path.write_text(text, encoding="utf-8")
    print("[vendor] patched staged Cargo.toml")

    try:
        tomllib.loads(text)
    except tomllib.TOMLDecodeError as exc:
        sys.stderr.write(f"[vendor] staged Cargo.toml is invalid TOML: {exc}\n")
        raise SystemExit(1) from exc


def regenerate_lockfile() -> None:
    """The source Cargo.lock was generated against the workspace path-deps;
    the staged tree's dependency graph differs (path-deps replaced by
    real registry deps from `klodi-{nats-client,rust-host,logger}`'s
    transitives). Drop the stale copy and run `cargo generate-lockfile`
    so subsequent `cargo build --locked` and `cargo publish --locked`
    have a consistent lockfile to lock against.
    """
    import subprocess

    lockfile = STAGED / "Cargo.lock"
    if lockfile.exists():
        lockfile.unlink()
    result = subprocess.run(
        ["cargo", "generate-lockfile"],
        cwd=STAGED,
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        sys.stderr.write(result.stderr)
        sys.stderr.write(
            "[vendor] `cargo generate-lockfile` failed in the staged tree.\n"
        )
        raise SystemExit(result.returncode)
    print("[vendor] regenerated staged Cargo.lock")


def main() -> int:
    stage_adapter()
    for mod in VENDORED_MODULES:
        stage_vendored_module(mod)
    stage_generated_catalog()
    write_staged_lib_rs()
    rewrite_vendored()
    rewrite_adapter_sources()
    patch_cargo()
    regenerate_lockfile()
    print(f"[vendor] done — staged tree ready at {STAGED}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
