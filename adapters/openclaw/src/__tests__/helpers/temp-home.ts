/**
 * Temporary KLODI_HOME directory for filesystem-based tests.
 * Creates sell/, buy/, policies/ subdirs and wires setKlodiHome().
 */

import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setKlodiHome } from "../../lib/paths.js";
import { clearConfigCache } from "../../lib/config.js";

export interface TempHome {
  path: string;
  sellDir: string;
  buyDir: string;
  policiesDir: string;
  cleanup: () => void;
}

export function createTempHome(): TempHome {
  const path = mkdtempSync(join(tmpdir(), "klodi-test-"));
  const sellDir = join(path, "sell");
  const buyDir = join(path, "buy");
  const policiesDir = join(path, "policies");

  mkdirSync(sellDir, { recursive: true });
  mkdirSync(buyDir, { recursive: true });
  mkdirSync(policiesDir, { recursive: true });

  setKlodiHome(path);
  clearConfigCache();

  return {
    path,
    sellDir,
    buyDir,
    policiesDir,
    cleanup: () => {
      rmSync(path, { recursive: true, force: true });
      setKlodiHome("");
      clearConfigCache();
    },
  };
}
