# klodi-nanobot — adapter build / publish targets.
#
# Mirrors klodi-plugin/adapters/openclaw/package.json scripts. Single
# source of truth for the nanobot adapter publish flow. Designed to run
# locally — there is no CI pipeline behind these targets by design.
#
# klodi-nats-client is NOT published as a separate package. It is
# vendored at build time into a staged copy of this adapter under
# build/staged/_klodi_nanobot_natsclient/, so the wheel that lands on
# PyPI is fully self-contained. See scripts/vendor.py.
#
# Usage:
#   make build         # produce wheel + sdist into ./dist/
#   make pack-inspect  # build + dump the wheel's file list
#   make smoke         # build + install wheel into a clean venv + import
#   make prepublish    # stamp-version + smoke + tag
#   make publish-dry   # prepublish + twine check (no upload)
#   make publish       # prepublish + twine upload  ←  the live publish
#   make clean         # rm build/ dist/ *.egg-info

ADAPTER := nanobot
PACKAGE := klodi-nanobot
HERE    := $(CURDIR)
STAGED  := $(HERE)/build/staged
DIST    := $(HERE)/dist

# awk avoids the Python-3.11+ tomllib dep so the Makefile works on the
# stock python3 (3.10) shipped with macOS Sequoia.
VERSION = $(shell awk -F'"' '/^\[project\]/{p=1;next} /^\[/{p=0} p && /^version[[:space:]]*=/{print $$2;exit}' $(HERE)/pyproject.toml)
TAG     = $(PACKAGE)-v$(VERSION)

.PHONY: help copy-skill vendor stamp-version render-readme build pack-inspect smoke tag changelog-check release-notes prepublish publish-dry publish clean

help:
	@echo "klodi-nanobot — adapter publish targets"
	@echo "  make build         build wheel + sdist into ./dist/"
	@echo "  make pack-inspect  build + dump wheel contents"
	@echo "  make smoke         build + install into a clean venv + import"
	@echo "  make stamp-version stamp version into versioned URLs"
	@echo "  make render-readme regenerate README.md (header + absolute repo links)"
	@echo "  make tag           create + push klodi-nanobot-v<version> git tag"
	@echo "  make changelog-check  validate CHANGELOG entry exists for this version"
	@echo "  make release-notes    print CHANGELOG entry for this version to stdout"
	@echo "  make prepublish    stamp-version + changelog-check + smoke + tag"
	@echo "  make publish-dry   prepublish + twine check"
	@echo "  make publish       prepublish + twine upload to PyPI"
	@echo "  make clean         rm build/ dist/ *.egg-info"

copy-skill:
	@python3 scripts/copy-skill.py

vendor: render-readme copy-skill
	@python3 scripts/vendor.py

stamp-version:
	@python3 scripts/stamp-version.py

render-readme:
	@node $(HERE)/../../scripts/render-publish-readme.mjs adapters/nanobot

build: vendor
	@rm -rf "$(DIST)"
	@python3 -m pip install --quiet --upgrade build
	@cd "$(STAGED)" && python3 -m build --outdir "$(DIST)"
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
	@python3 -m pip install --quiet --upgrade twine
	@python3 -m twine check $(DIST)/*

publish: prepublish
	@python3 -m pip install --quiet --upgrade twine
	@python3 -m twine upload $(DIST)/*

clean:
	@rm -rf build/ dist/ *.egg-info
	@find . -type d -name __pycache__ -prune -exec rm -rf {} +
	@echo "[clean] done"
