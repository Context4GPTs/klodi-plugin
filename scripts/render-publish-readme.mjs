#!/usr/bin/env node
// Render each adapter's README.md into its publish-ready shape:
//   1. Replace everything above the first H1 with the shared header at
//      docs/publish-readme-header.md (empty by default — adapter READMEs
//      lead with their own technical lede starting at the H1).
//   2. Rewrite every relative repo link in the body to an absolute
//      https://github.com/Context4GPTs/klodi-plugin URL — registry pages
//      (npm, PyPI, crates.io, ClawHub) cannot resolve `../../README.md`.
//
// Idempotent: rerunning produces the same output. Wired into each
// adapter's prepublish flow so the published artifact always carries
// the latest header + working links.
//
// Usage:
//   node scripts/render-publish-readme.mjs                 # render all 6
//   node scripts/render-publish-readme.mjs adapters/hermes # render one
//   node scripts/render-publish-readme.mjs --check         # exit 1 on drift

import { readFileSync, writeFileSync, statSync, existsSync } from 'node:fs';
import { dirname, join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_URL = 'https://github.com/Context4GPTs/klodi-plugin';
const BRANCH = 'main';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..');
const HEADER_PATH = join(REPO_ROOT, 'docs', 'publish-readme-header.md');

const ADAPTERS = [
    'adapters/openclaw',
    'adapters/hermes',
    'adapters/nanobot',
    'adapters/ironclaw',
    'adapters/moltis',
    'adapters/zeroclaw',
];

function isExternalLink(url) {
    return /^([a-z][a-z0-9+.-]*:|#|mailto:)/i.test(url);
}

function resolveRepoPath(readmeRepoPath, href) {
    // Strip optional fragment / query — preserve them for the final URL.
    const hashIdx = href.indexOf('#');
    const queryIdx = href.indexOf('?');
    const cut = [hashIdx, queryIdx].filter(i => i >= 0).sort((a, b) => a - b)[0] ?? -1;
    const pathPart = cut >= 0 ? href.slice(0, cut) : href;
    const suffix = cut >= 0 ? href.slice(cut) : '';

    const readmeDir = posix.dirname(readmeRepoPath);
    const resolved = posix.normalize(posix.join(readmeDir, pathPart));
    return { resolved, suffix };
}

function pickBlobOrTree(absRepoPath) {
    const fsPath = join(REPO_ROOT, absRepoPath);
    if (existsSync(fsPath)) {
        return statSync(fsPath).isDirectory() ? 'tree' : 'blob';
    }
    // Fallback: extension → file, no extension → dir.
    return /\.[a-z0-9]+$/i.test(absRepoPath) ? 'blob' : 'tree';
}

function rewriteLinks(body, readmeRepoPath) {
    // Markdown inline links: [text](url) and [text](url "title").
    // Skips images (![…]) by requiring no leading ! before the [.
    const linkRe = /(^|[^!])\[((?:[^\[\]]|\\.)*)\]\(([^)\s]+)(\s+"[^"]*")?\)/g;
    return body.replace(linkRe, (match, lead, text, href, title) => {
        if (isExternalLink(href)) return match;

        const { resolved, suffix } = resolveRepoPath(readmeRepoPath, href);
        if (resolved.startsWith('..')) {
            // Path escapes the repo — leave alone.
            return match;
        }
        const kind = pickBlobOrTree(resolved);
        const absUrl = `${REPO_URL}/${kind}/${BRANCH}/${resolved}${suffix}`;
        return `${lead}[${text}](${absUrl}${title ?? ''})`;
    });
}

function render(adapterDir) {
    const readmePath = join(REPO_ROOT, adapterDir, 'README.md');
    const headerSrc = readFileSync(HEADER_PATH, 'utf8');
    const original = readFileSync(readmePath, 'utf8');

    // Find first H1 — body starts there.
    const lines = original.split('\n');
    const h1Idx = lines.findIndex(l => /^#\s+/.test(l));
    if (h1Idx < 0) {
        throw new Error(`${adapterDir}/README.md: no H1 (\`# klodi — …\`) found — every adapter README must start with one.`);
    }

    const body = lines.slice(h1Idx).join('\n');
    const readmeRepoPath = posix.join(adapterDir, 'README.md');
    const rewrittenBody = rewriteLinks(body, readmeRepoPath);

    // Empty header → emit just the body so registry pages start at the H1
    // without a leading blank line.
    if (headerSrc.trim() === '') {
        return rewrittenBody;
    }

    // Header is verbatim (it already uses absolute URLs by convention).
    return headerSrc.endsWith('\n') ? headerSrc + rewrittenBody : headerSrc + '\n' + rewrittenBody;
}

function main() {
    const args = process.argv.slice(2);
    const checkMode = args.includes('--check');
    const targets = args.filter(a => a !== '--check');

    // Positional args are repo-relative paths (e.g. `adapters/hermes`) so
    // the script behaves identically whether invoked from repo root or
    // from inside an adapter dir (Makefiles/pnpm both pass the same arg).
    const adapters = targets.length > 0
        ? targets.map(t => t.replace(/^[./]+/, '').replace(/\/+$/, ''))
        : ADAPTERS;

    let drift = 0;
    for (const adapter of adapters) {
        const readmePath = join(REPO_ROOT, adapter, 'README.md');
        const rendered = render(adapter);
        const current = readFileSync(readmePath, 'utf8');
        if (rendered === current) {
            console.log(`[render-publish-readme] ${adapter}/README.md up to date.`);
            continue;
        }
        if (checkMode) {
            console.error(`[render-publish-readme] DRIFT: ${adapter}/README.md is stale. Run \`node scripts/render-publish-readme.mjs\` and commit the result.`);
            drift++;
        } else {
            writeFileSync(readmePath, rendered);
            console.log(`[render-publish-readme] wrote ${adapter}/README.md`);
        }
    }

    if (checkMode && drift > 0) process.exit(1);
}

main();
