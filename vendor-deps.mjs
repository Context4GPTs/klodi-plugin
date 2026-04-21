/**
 * Copy runtime deps into dist/node_modules/ after tsc emits dist/.
 *
 * OpenClaw installs plugins by extracting the published tarball into
 * `~/.openclaw/extensions/<id>/` without running npm install, so a
 * plain tsc output crashes at load with `Cannot find module 'nats'`.
 * Shipping the deps adjacent to dist/ lets Node's resolver find them
 * one level up from dist/*.js.
 *
 * This script uses only node:fs — OpenClaw's safety scanner blocks
 * plugin install when any file in the plugin directory uses
 * `child_process`, so the tsc step lives in package.json's script
 * chain rather than here.
 */

import { cpSync, existsSync } from "node:fs";

const VENDORED = [
  "@nats-io/nats-core",
  "@nats-io/jetstream",
  "@nats-io/nkeys",
  "@nats-io/nuid",
  "tweetnacl",
  "@sinclair/typebox",
  "ws",
];

if (!existsSync("dist")) {
  console.error("[klodi-plugin] dist/ missing — run tsc first.");
  process.exit(1);
}

for (const name of VENDORED) {
  cpSync(`node_modules/${name}`, `dist/node_modules/${name}`, {
    recursive: true,
    dereference: true,
  });
}

console.log(
  `[klodi-plugin] vendored ${VENDORED.join(", ")} into dist/node_modules`,
);
