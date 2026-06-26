# klodi-hermes — adapter build / publish targets.
#
# Mirrors klodi-plugin/adapters/openclaw/package.json scripts. Single
# source of truth for the Hermes adapter publish flow. Designed to run
# locally (founder workstation, ad-hoc publishes) — there is no CI
# pipeline behind these targets by design.
#
# klodi-nats-client is NOT published as a separate package. It is
# vendored at build time into a staged copy of this adapter under
# build/staged/_klodi_hermes_natsclient/, so the wheel that lands on
# PyPI is fully self-contained. See scripts/vendor.py.
#
# The vendored client carries `schemas.json`, generated from the
# TypeBox catalog at packages/tool-catalog/src/. Every wheel build runs
# `pnpm --filter @klodi/tool-catalog codegen` first (the `codegen`
# target) so the wheel can never ship a schema older than the catalog
# source. Without this hook, edits to the TS catalog land in TypeScript
# but the Python mirror keeps the stale shape — exactly the drift that
# silently shipped delivery_method/ships_to in 0.2.0–0.2.1 long after
# the catalog had moved to the `fulfillment` discriminated-union.
#
# Usage:
#   make build         # produce wheel + sdist into ./dist/
#   make pack-inspect  # build + dump the wheel's file list
#   make smoke         # build + install wheel into a clean venv + import
#   make prepublish    # stamp-version + smoke + tag
#   make publish-dry   # prepublish + twine check (no upload)
#   make publish       # prepublish + twine upload  ←  the live publish
#   make clean         # rm build/ dist/ *.egg-info

ADAPTER := hermes
PACKAGE := klodi-hermes
HERE    := $(CURDIR)
STAGED  := $(HERE)/build/staged
DIST    := $(HERE)/dist

# Lazy — `make help` shouldn't fail in a fresh clone before pyproject is read.
# awk avoids the Python-3.11+ tomllib dep so the Makefile works on the
# stock python3 (3.10) shipped with macOS Sequoia.
VERSION = $(shell awk -F'"' '/^\[project\]/{p=1;next} /^\[/{p=0} p && /^version[[:space:]]*=/{print $$2;exit}' $(HERE)/pyproject.toml)
TAG     = $(PACKAGE)-v$(VERSION)

.PHONY: help copy-skill codegen clean-build-state vendor stamp-version render-readme build pack-inspect smoke tag changelog-check release-notes prepublish publish-dry publish clean

help:
	@echo "klodi-hermes — adapter publish targets"
	@echo "  make build         build wheel + sdist into ./dist/"
	@echo "  make clean-build-state  rm source-tree egg-info / build / dist"
	@echo "  make pack-inspect  build + dump wheel contents"
	@echo "  make smoke         build + install into a clean venv + import"
	@echo "  make codegen       regenerate packages/*/schemas.json from the TS catalog"
	@echo "  make stamp-version stamp version into plugin.yaml + versioned URLs"
	@echo "  make render-readme regenerate README.md (header + absolute repo links)"
	@echo "  make tag           create + push klodi-hermes-v<version> git tag"
	@echo "  make changelog-check  validate CHANGELOG entry exists for this version"
	@echo "  make release-notes    print CHANGELOG entry for this version to stdout"
	@echo "  make prepublish    stamp-version + changelog-check + smoke + tag"
	@echo "  make publish-dry   prepublish + twine check"
	@echo "  make publish       prepublish + twine upload to PyPI"
	@echo "  make clean         rm build/ dist/ *.egg-info"

copy-skill:
	@python3 scripts/copy-skill.py

# Regenerate the JSON Schema export from the TypeBox catalog. Mirrors
# the result into packages/{nats-client-py,logger-py}/src/.../schemas.json,
# which vendor.py then copies into the staged wheel. Run unconditionally
# before `vendor` — codegen is idempotent and cheap, and skipping it is
# how the 0.2.0–0.2.1 wheels shipped a stale `delivery_method`-shaped
# schema after the catalog flipped to the `fulfillment` union. The
# committed mirrors must be re-committed if this changes them; CI's
# check-codegen-fresh gate will fail on uncommitted drift.
codegen:
	@cd "$(HERE)/../.." && pnpm --filter @klodi/tool-catalog codegen

# P3-4: source-tree egg-info / build / dist are stale build artefacts
# from prior `pip install -e .` or local `python -m build .` runs and
# can otherwise leak into the wheel (PKG-INFO from a pre-0012 install
# would surface deleted tools like `klodi_pending`). vendor.py also
# excludes these from the staged copy, but cleaning here is the
# belt-and-braces guarantee that no developer can accidentally ship a
# wheel built against stale metadata.
clean-build-state:
	@rm -rf "$(HERE)/build" "$(HERE)/dist" "$(HERE)"/*.egg-info
	@echo "[clean-build-state] removed local egg-info / build / dist"

vendor: render-readme codegen copy-skill clean-build-state
	@python3 scripts/vendor.py

stamp-version:
	@python3 scripts/stamp-version.py

render-readme:
	@node $(HERE)/../../scripts/render-publish-readme.mjs adapters/hermes

build: vendor
	@rm -rf "$(DIST)"
	@cd "$(STAGED)" && uv build --out-dir "$(DIST)"
	@echo "[build] $(PACKAGE) artifacts ready in $(DIST)"

pack-inspect: build
	@echo "[pack-inspect] wheel contents:"
	@python3 -c "import glob,zipfile;w=glob.glob('$(DIST)/*.whl')[0];print(w);print('\n'.join(sorted(zipfile.ZipFile(w).namelist())))"

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
	@uvx twine check $(DIST)/*

publish: prepublish
	@uvx twine upload $(DIST)/*

clean:
	@rm -rf build/ dist/ *.egg-info
	@find . -type d -name __pycache__ -prune -exec rm -rf {} +
	@echo "[clean] done"
