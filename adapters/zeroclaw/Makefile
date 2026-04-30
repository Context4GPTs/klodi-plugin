# klodi-zeroclaw — adapter build / publish targets.
#
# Mirrors klodi-plugin/adapters/openclaw/package.json scripts. Single
# source of truth for the ZeroClaw adapter publish flow. Designed to
# run locally — there is no CI pipeline behind these targets by design.
#
# klodi-nats-client (Rust crate) is NOT published as a separate crate
# (publish = false on packages/nats-client-rs/Cargo.toml). It is
# vendored at build time into a staged copy of this adapter under
# build/staged/src/_natsclient/, so the .crate that lands on crates.io
# is fully self-contained. See scripts/vendor.py.
#
# Usage:
#   make build         # cargo build --release from staged dir
#   make pack-inspect  # vendor + cargo package + dump .crate contents
#   make smoke         # build + run --help on each declared [[bin]]
#   make prepublish    # stamp-version + smoke + tag
#   make publish-dry   # prepublish + cargo publish --dry-run (staged)
#   make publish       # prepublish + cargo publish (staged) ← live
#   make clean         # rm -rf build/

ADAPTER := zeroclaw
PACKAGE := klodi-zeroclaw
HERE    := $(CURDIR)
STAGED  := $(HERE)/build/staged

# vendor.py uses tomllib (3.11+) to read the shared crate's transitive
# deps. Find the best Python on PATH; fall back to plain python3 last.
# Override with `make PYTHON=/path/to/python3.13 build` if the auto-pick
# is wrong.
PYTHON ?= $(shell command -v python3.13 2>/dev/null || command -v python3.12 2>/dev/null || command -v python3.11 2>/dev/null || command -v python3)

# awk avoids the Python-3.11+ tomllib dep so the Makefile works on the
# stock python3 (3.10) shipped with macOS Sequoia.
VERSION = $(shell awk -F'"' '/^\[package\]/{p=1;next} /^\[/{p=0} p && /^version[[:space:]]*=/{print $$2;exit}' $(HERE)/Cargo.toml)
TAG     = $(PACKAGE)-v$(VERSION)

.PHONY: help vendor stamp-version render-readme build pack-inspect smoke tag changelog-check release-notes prepublish publish-dry publish clean

help:
	@echo "klodi-zeroclaw — adapter publish targets"
	@echo "  make build         vendor + cargo build --release from staged"
	@echo "  make pack-inspect  vendor + cargo package + dump .crate contents"
	@echo "  make smoke         build + run --help on each declared [[bin]]"
	@echo "  make stamp-version stamp version into versioned URLs"
	@echo "  make render-readme regenerate README.md (header + absolute repo links)"
	@echo "  make tag           create + push klodi-zeroclaw-v<version> git tag"
	@echo "  make changelog-check  validate CHANGELOG entry exists for this version"
	@echo "  make release-notes    print CHANGELOG entry for this version to stdout"
	@echo "  make prepublish    stamp-version + changelog-check + smoke + tag"
	@echo "  make publish-dry   prepublish + cargo publish --dry-run (staged)"
	@echo "  make publish       prepublish + cargo publish (staged) → crates.io"
	@echo "  make clean         rm -rf build/"

render-readme:
	@node $(HERE)/../../scripts/render-publish-readme.mjs adapters/zeroclaw

vendor: render-readme
	@$(PYTHON) scripts/vendor.py

stamp-version:
	@bash scripts/stamp-version.sh

build: vendor
	@cd "$(STAGED)" && cargo build --release --locked
	@echo "[build] $(PACKAGE) release binaries in $(STAGED)/target/release/"

pack-inspect: vendor
	@cd "$(STAGED)" && cargo package --locked
	@echo "[pack-inspect] crate contents:"
	@cd "$(STAGED)" && tar -tzf target/package/$(PACKAGE)-$(VERSION).crate | sort

smoke: build
	@bash scripts/smoke.sh

tag:
	@bash scripts/tag.sh

changelog-check:
	@python3 scripts/changelog-extract.py

release-notes:
	@python3 scripts/changelog-extract.py --print

prepublish: stamp-version changelog-check smoke tag

publish-dry: prepublish
	@cd "$(STAGED)" && cargo publish --locked --dry-run

publish: prepublish
	@cd "$(STAGED)" && cargo publish --locked

clean:
	@rm -rf build/
	@echo "[clean] done"
