#!/usr/bin/env python3
"""Vendor klodi-nats-client (Rust) into a staged copy of the Moltis adapter.

klodi-nats-client (the crate at klodi-plugin/packages/nats-client-rs/)
is NOT published to crates.io as a standalone crate (publish = false on
its Cargo.toml). Instead, every Rust host adapter ships its own copy
inlined as a private sub-module, so the .crate that lands on crates.io
is fully self-contained.

The staged copy under build/staged/ is what `cargo build` /
`cargo publish` runs against — the source tree under
adapters/moltis/ is never modified, so local dev (`cargo check`,
`cargo test`) keeps working against the workspace path-dep.

Operations:
    1.  Stage adapter source (Cargo.toml, src/, README.md) → build/staged/.
    2.  Copy klodi-nats-client/src/*.rs → build/staged/src/_natsclient/,
        renaming the original `lib.rs` to `mod.rs`.
    3.  Rewrite imports:
          a) Vendored files (build/staged/src/_natsclient/*.rs):
                `crate::`            → `super::`
             Inside the original crate, internal refs were absolute
             from its own root. After vendoring, that root is the
             enclosing _natsclient module, which from any file under
             _natsclient/ is `super::`.
          b) Adapter lib + non-bin sources (build/staged/src/*.rs other
             than lib.rs / bin/):
                `klodi_nats_client::` → `crate::_natsclient::`
          c) Adapter lib root (build/staged/src/lib.rs):
                inject `pub mod _natsclient;`, then run rule (b).
                `pub mod` is required so bin crates can reach the
                vendored types via `klodi_moltis::_natsclient::*`.
          d) Adapter bin sources (build/staged/src/bin/*.rs):
                `klodi_nats_client::` → `klodi_moltis::_natsclient::`
             Bin crates can't use `crate::` to reach the lib's
             modules, so the bin path goes through the lib name.
    4.  Patch staged Cargo.toml:
        — Drop `klodi-nats-client = { path = ... }` from [dependencies].
        — Add transitive deps the vendored module needs and the adapter
          itself does not already declare (async-nats, lru, thiserror).
        — Inject `[workspace]` table so cargo treats the staged dir as
          its own workspace root (no walking up to find a parent).
"""

from __future__ import annotations

import re
import shutil
import sys
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
SHARED_SRC = REPO_ROOT / "packages" / "nats-client-rs" / "src"
SHARED_CARGO = REPO_ROOT / "packages" / "nats-client-rs" / "Cargo.toml"
STAGED = HERE / "build" / "staged"

ADAPTER_SLUG = "moltis"
ADAPTER_LIB_NAME = f"klodi_{ADAPTER_SLUG}"  # matches Cargo.toml [lib].name

# Source-tree noise that should never reach the staged copy. Mirrors
# the Python adapters' exclude list, plus Cargo's target/ which would
# otherwise dump tens of MB of build artefacts into the staged copy.
COPY_EXCLUDES = (
    "target",
    "build",
    "__pycache__",
    ".pytest_cache",
    "node_modules",
    ".venv",
)


def should_skip(rel: Path) -> bool:
    return any(part in COPY_EXCLUDES for part in rel.parts)


def stage_adapter() -> None:
    """Copy adapter source into build/staged/, skipping local build noise."""
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


def stage_shared_crate() -> None:
    """Copy klodi-nats-client/src/*.rs into staged src/_natsclient/."""
    if not SHARED_SRC.exists():
        sys.stderr.write(
            f"[vendor] missing shared crate source at {SHARED_SRC}\n"
            "         — workspace layout is broken\n"
        )
        raise SystemExit(1)

    target = STAGED / "src" / "_natsclient"
    target.mkdir(parents=True, exist_ok=True)
    for rs in SHARED_SRC.glob("*.rs"):
        if rs.name == "lib.rs":
            shutil.copy2(rs, target / "mod.rs")
        else:
            shutil.copy2(rs, target / rs.name)
    print(f"[vendor] copied klodi-nats-client → src/_natsclient/")


def rewrite_vendored() -> int:
    """Inside _natsclient/, `crate::` (which used to mean the shared crate's
    root) becomes `super::` — relative to the enclosing _natsclient module."""
    pattern = re.compile(r"\bcrate::")
    rewritten = 0
    natsclient = STAGED / "src" / "_natsclient"
    for rs in natsclient.glob("*.rs"):
        text = rs.read_text(encoding="utf-8")
        new = pattern.sub("super::", text)
        if new != text:
            rs.write_text(new, encoding="utf-8")
            rewritten += 1
    print(f"[vendor] rewrote crate:: → super:: in {rewritten} vendored file(s)")
    return rewritten


def rewrite_adapter_sources() -> tuple[int, int]:
    """Rewrite adapter sources to point at the vendored module.

    Returns (lib_count, bin_count) for logging.
    """
    lib_pattern = re.compile(r"\bklodi_nats_client::")
    bin_pattern = re.compile(r"\bklodi_nats_client::")
    lib_count = 0
    bin_count = 0

    src = STAGED / "src"
    for rs in src.rglob("*.rs"):
        if not rs.is_file():
            continue
        # Skip already-vendored sources; they were rewritten in rewrite_vendored().
        rel = rs.relative_to(src)
        if rel.parts and rel.parts[0] == "_natsclient":
            continue

        text = rs.read_text(encoding="utf-8")
        if rel.parts and rel.parts[0] == "bin":
            new = bin_pattern.sub(
                f"{ADAPTER_LIB_NAME}::_natsclient::", text
            )
            if new != text:
                bin_count += 1
        else:
            new = lib_pattern.sub("crate::_natsclient::", text)
            if new != text:
                lib_count += 1
        if new != text:
            rs.write_text(new, encoding="utf-8")

    print(
        f"[vendor] rewrote {lib_count} adapter lib file(s) "
        f"and {bin_count} bin file(s)"
    )
    return lib_count, bin_count


def inject_pub_mod_natsclient() -> None:
    """Add `pub mod _natsclient;` to staged src/lib.rs."""
    lib_rs = STAGED / "src" / "lib.rs"
    text = lib_rs.read_text(encoding="utf-8")
    if "pub mod _natsclient" in text:
        return
    # Insert at the top after the file's opening doc comments / inner
    # attributes so the module declaration sits with the other `pub mod`s.
    insertion = (
        "\n// Auto-injected by scripts/vendor.py — vendored copy of\n"
        "// klodi-nats-client. Lives here instead of as a separate crate\n"
        "// because klodi-nats-client is internal-only (publish = false).\n"
        "// Marked pub so bin crates can reach types via\n"
        "// `klodi_moltis::_natsclient::*`.\n"
        "pub mod _natsclient;\n"
    )
    # Place after the last leading `//!` doc comment block, or at top.
    lines = text.splitlines(keepends=True)
    insert_idx = 0
    for i, line in enumerate(lines):
        if line.startswith("//!") or line.startswith("//"):
            insert_idx = i + 1
        else:
            break
    lines.insert(insert_idx, insertion)
    lib_rs.write_text("".join(lines), encoding="utf-8")
    print("[vendor] injected `pub mod _natsclient;` into staged src/lib.rs")


# ----------------------------------------------------------------------
# Cargo.toml patching
# ----------------------------------------------------------------------

# Deps that the vendored module needs and the adapter does not already
# declare. Read from packages/nats-client-rs/Cargo.toml at vendor time
# so a new shared-client dep automatically lands in the staged adapter.
def shared_dep_lines_to_inject(staged_cargo_text: str) -> list[str]:
    """Read shared client's [dependencies], return TOML lines for deps
    not already pinned in the staged adapter Cargo.toml."""
    shared_data = tomllib.loads(SHARED_CARGO.read_text(encoding="utf-8"))
    shared_deps = shared_data.get("dependencies", {}) or {}

    staged_data = tomllib.loads(staged_cargo_text)
    staged_deps = staged_data.get("dependencies", {}) or {}

    extra_lines: list[str] = []
    for name, spec in shared_deps.items():
        if name == "klodi-nats-client":
            continue
        if name in staged_deps:
            # Adapter already pins this dep — its pin wins.
            continue
        # Preserve the spec form (string or inline table).
        if isinstance(spec, str):
            extra_lines.append(f'{name} = "{spec}"\n')
        elif isinstance(spec, dict):
            inline = ", ".join(
                f'{k} = {_toml_value(v)}' for k, v in spec.items()
            )
            extra_lines.append(f"{name} = {{ {inline} }}\n")
    return extra_lines


def _toml_value(v: object) -> str:
    """Cheap inline-TOML formatter for values we expect (str, bool, list[str])."""
    if isinstance(v, str):
        return f'"{v}"'
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, list):
        items = ", ".join(_toml_value(x) for x in v)
        return f"[{items}]"
    raise ValueError(f"unsupported TOML value type: {type(v).__name__}")


def patch_cargo() -> None:
    """Drop the path-dep, inject missing shared deps, isolate as a workspace."""
    cargo_path = STAGED / "Cargo.toml"
    text = cargo_path.read_text(encoding="utf-8")

    # 1. Drop the klodi-nats-client = { path = ... } line. Match the
    # whole line including any inline table braces and trailing newline.
    before = text
    text = re.sub(
        r'^\s*klodi-nats-client\s*=\s*(?:\{[^\}]*\}|"[^"]*")\s*\n',
        "",
        text,
        flags=re.MULTILINE,
    )
    if text == before:
        sys.stderr.write(
            "[vendor] WARNING: did not find a klodi-nats-client dep line "
            "to drop in staged Cargo.toml — was it already removed?\n"
        )

    # 2. Inject missing transitive deps from the shared client.
    extra = shared_dep_lines_to_inject(text)
    if extra:
        # Append after the [dependencies] header, after existing deps.
        # We append at end of file to avoid disturbing inline-table dep
        # formatting elsewhere.
        marker = "\n# Vendored from klodi-nats-client (scripts/vendor.py).\n"
        text = text.rstrip() + "\n" + marker + "".join(extra)
        print(
            f"[vendor] injected {len(extra)} transitive dep line(s) "
            "from klodi-nats-client"
        )

    # 3. Make staged dir a workspace root so cargo doesn't walk up.
    if "[workspace]" not in text:
        text += "\n[workspace]\n"

    cargo_path.write_text(text, encoding="utf-8")
    print("[vendor] patched staged Cargo.toml")

    # Round-trip sanity.
    try:
        tomllib.loads(text)
    except tomllib.TOMLDecodeError as exc:
        sys.stderr.write(f"[vendor] staged Cargo.toml is invalid TOML: {exc}\n")
        raise SystemExit(1) from exc


def main() -> int:
    stage_adapter()
    stage_shared_crate()
    inject_pub_mod_natsclient()
    rewrite_vendored()
    rewrite_adapter_sources()
    patch_cargo()
    print(f"[vendor] done — staged tree ready at {STAGED}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
