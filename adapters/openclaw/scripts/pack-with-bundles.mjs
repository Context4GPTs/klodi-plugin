#!/usr/bin/env node
/**
 * Pack the publishable artifact with bundleDependencies materialized.
 *
 * Why this exists, in three constraints:
 *
 *   1. ClawHub strips `package/dist/node_modules/` on ingest. Anything
 *      relied on at runtime that lives only there is gone post-publish.
 *      Workspace deps (@klodi/nats-client, @klodi/tool-catalog) are
 *      not on the public registry, so a normal `npm install` on the
 *      user's host 404s — they have to ride into the tarball under a
 *      path ClawHub preserves: top-level `node_modules/<name>/`.
 *      `bundleDependencies` is the npm-spec mechanism for that.
 *
 *   2. pnpm pack refuses bundleDependencies when the workspace uses
 *      node-linker=isolated (ERR_PNPM_BUNDLED_DEPENDENCIES_WITHOUT_HOISTED).
 *      Switching the whole workspace to hoisted is too invasive.
 *      `npm pack` honors bundleDependencies regardless of pnpm linker.
 *
 *   3. pnpm symlinks `node_modules/@klodi/nats-client` → the workspace
 *      source tree (`klodi-plugin/packages/nats-client-ts/`), which
 *      contains src/, tests/, .claude/, node_modules/. Following the
 *      symlink during pack would bloat the tarball and trip OpenClaw's
 *      safety scan on test files that mock process.env. We replace
 *      each symlink with a lean directory holding only dist/ +
 *      package.json before pack, restore the symlink after.
 *
 * `npm pack` also doesn't rewrite `workspace:*` specifiers (that's a
 * pnpm thing). Without rewrite, the published package.json carries
 * `"workspace:*"` which npm install rejects. The script does the
 * rewrite using the version each bundled package declares.
 *
 * Atomic via try/finally: source tree is restored on success or
 * failure. Mutations are confined to:
 *   - package.json (workspace:* → concrete version)
 *   - node_modules/<bundleDep>/ (symlink → lean dir)
 * Both are recorded before mutation and restored after.
 *
 * Usage:
 *   node scripts/pack-with-bundles.mjs --pack-destination /tmp/dest
 *
 * Exit codes:
 *   0  pack succeeded; tarball at <destination>/4gpts-klodi-<v>.tgz
 *   1  pack failed (npm pack non-zero or restore failed mid-flight)
 *   2  bad usage / pre-flight failure
 */

import {
  cpSync, existsSync, lstatSync, mkdirSync, readFileSync,
  readlinkSync, rmSync, symlinkSync, unlinkSync, writeFileSync,
} from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PACKAGE_DIR = resolve(HERE, '..')
const PACKAGE_JSON_PATH = join(PACKAGE_DIR, 'package.json')
const NODE_MODULES = join(PACKAGE_DIR, 'node_modules')
const REPO_ROOT = resolve(PACKAGE_DIR, '../../..')
const WORKSPACE_PACKAGES_DIR = join(REPO_ROOT, 'klodi-plugin', 'packages')

function logInfo(msg) {
  console.info(`[pack-with-bundles] ${msg}`)
}

function parseArgs() {
  const args = process.argv.slice(2)
  const idx = args.indexOf('--pack-destination')
  if (idx === -1 || !args[idx + 1]) {
    console.error('[pack-with-bundles] --pack-destination <dir> required')
    process.exit(2)
  }
  return { destination: resolve(args[idx + 1]) }
}

function readPackageJson() {
  return JSON.parse(readFileSync(PACKAGE_JSON_PATH, 'utf8'))
}

/**
 * Locate a bundled workspace dep's source directory by reading the
 * pnpm symlink at node_modules/<name>/. The symlink is the single
 * source of truth for which workspace tree the dep maps to —
 * hand-coded mappings drift.
 */
function resolveBundleSource(name) {
  const linkPath = join(NODE_MODULES, name)
  if (!existsSync(linkPath)) {
    throw new Error(
      `${name} not found at ${linkPath}. Run \`pnpm install\` first.`,
    )
  }
  const stat = lstatSync(linkPath)
  if (!stat.isSymbolicLink()) {
    throw new Error(
      `${linkPath} is not a symlink. ` +
      'Either already materialized (re-run pnpm install) or pnpm linker changed.',
    )
  }
  const linkTarget = readlinkSync(linkPath)
  const sourceDir = resolve(dirname(linkPath), linkTarget)
  if (!sourceDir.startsWith(WORKSPACE_PACKAGES_DIR)) {
    throw new Error(
      `${name} resolves to ${sourceDir}, outside ${WORKSPACE_PACKAGES_DIR}. ` +
      'Refusing to bundle content from outside the workspace.',
    )
  }
  const sourcePkgPath = join(sourceDir, 'package.json')
  if (!existsSync(sourcePkgPath)) {
    throw new Error(`${sourcePkgPath} missing — cannot read version.`)
  }
  const sourcePkg = JSON.parse(readFileSync(sourcePkgPath, 'utf8'))
  return { name, linkPath, linkTarget, sourceDir, version: sourcePkg.version }
}

/**
 * Replace a symlink with a directory containing only the runtime
 * payload (dist/ + a deps-stripped package.json). Returns a restore
 * closure.
 *
 * The bundled package.json's `dependencies` field is stripped — if
 * left intact, npm pack would recursively bundle transitive deps,
 * walking into pnpm's `.pnpm/` symlink farm and emitting path-
 * traversal entries (`package/../../../node_modules/.pnpm/...`)
 * that produce an unextractable tarball. Runtime resolution doesn't
 * read this package.json's dependencies; Node walks node_modules/
 * upward and finds each external at the plugin's top-level
 * node_modules/<name>/ (installed by the host's `npm install` from
 * the plugin's own package.json#dependencies).
 */
function materialize(bundle) {
  const { linkPath, linkTarget, sourceDir } = bundle
  const distSrc = join(sourceDir, 'dist')
  if (!existsSync(distSrc)) {
    throw new Error(
      `${distSrc} missing. Run \`pnpm --filter @4gpts/klodi... build\` first.`,
    )
  }

  // Node's rmSync follows the symlink to its directory target and
  // refuses with ERR_FS_EISDIR. unlinkSync operates on the link itself.
  unlinkSync(linkPath)
  mkdirSync(linkPath, { recursive: true })
  cpSync(distSrc, join(linkPath, 'dist'), {
    recursive: true,
    dereference: true,
    force: true,
  })

  const sourcePkg = JSON.parse(
    readFileSync(join(sourceDir, 'package.json'), 'utf8'),
  )
  const strippedPkg = { ...sourcePkg }
  delete strippedPkg.dependencies
  delete strippedPkg.devDependencies
  delete strippedPkg.scripts
  writeFileSync(
    join(linkPath, 'package.json'),
    JSON.stringify(strippedPkg, null, 2) + '\n',
  )

  return function restore() {
    rmSync(linkPath, { recursive: true, force: true })
    symlinkSync(linkTarget, linkPath, 'dir')
  }
}

/**
 * Rewrite workspace:* specifiers to concrete versions read from each
 * bundled package's own package.json. npm pack doesn't do this and
 * `workspace:*` in a published tarball is a non-installable specifier.
 */
function rewritePackageJson(bundles) {
  const original = readFileSync(PACKAGE_JSON_PATH, 'utf8')
  const pkg = JSON.parse(original)
  const versions = new Map(bundles.map((b) => [b.name, b.version]))
  const newDeps = {}
  for (const [depName, depRange] of Object.entries(pkg.dependencies ?? {})) {
    if (depRange === 'workspace:*') {
      const concrete = versions.get(depName)
      if (!concrete) {
        throw new Error(
          `${depName} declared as workspace:* but not in bundleDependencies. ` +
          'Add it to bundleDependencies or pin a registry version.',
        )
      }
      newDeps[depName] = concrete
    } else {
      newDeps[depName] = depRange
    }
  }
  pkg.dependencies = newDeps
  writeFileSync(PACKAGE_JSON_PATH, JSON.stringify(pkg, null, 2) + '\n')
  return function restore() {
    writeFileSync(PACKAGE_JSON_PATH, original)
  }
}

function runNpmPack(destination) {
  mkdirSync(destination, { recursive: true })
  execFileSync('npm', ['pack', '--pack-destination', destination], {
    cwd: PACKAGE_DIR,
    stdio: 'inherit',
    timeout: 60_000,
  })
}

function main() {
  const { destination } = parseArgs()
  const pkg = readPackageJson()
  const bundleDeps = pkg.bundleDependencies ?? []
  if (bundleDeps.length === 0) {
    console.error('[pack-with-bundles] bundleDependencies empty — nothing to materialize.')
    process.exit(2)
  }

  logInfo(`resolving ${bundleDeps.length} bundle(s): ${bundleDeps.join(', ')}`)
  const bundles = bundleDeps.map((name) => resolveBundleSource(name))

  const restores = []
  let packed = false
  try {
    restores.push(rewritePackageJson(bundles))
    logInfo('rewrote workspace:* → concrete versions')
    for (const bundle of bundles) {
      restores.push(materialize(bundle))
      logInfo(`materialized ${bundle.name}@${bundle.version}`)
    }
    logInfo(`npm pack → ${destination}`)
    runNpmPack(destination)
    packed = true
  } finally {
    for (const restore of restores.reverse()) {
      try {
        restore()
      } catch (err) {
        console.error(`[pack-with-bundles] restore failed: ${err.message}`)
      }
    }
    logInfo('source tree restored')
  }

  if (!packed) process.exit(1)
}

main()
