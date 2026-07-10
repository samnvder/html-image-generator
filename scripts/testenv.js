// Test isolation: no suite may write into the user's outputs/.
//
// Before this existed, selftest/templatetest/apptest rendered into
// outputs/south-end/ and outputs/demo/, so the app's Recent Outputs panel listed
// `selftest-letter` and `audit-probe` next to real client work.
//
// Call this at the top of a suite, before the first render. paths.js reads
// HIG_OUTPUTS_ROOT at call time, so setting it after the imports have run is fine.
// If it is already set — as it is in the server apptest spawns — we adopt it, so
// parent and child render into the same root.

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export async function useTempOutputs(label) {
  if (!process.env.HIG_OUTPUTS_ROOT) {
    process.env.HIG_OUTPUTS_ROOT = await fs.mkdtemp(path.join(os.tmpdir(), `hig-${label}-`));
  }
  const root = path.resolve(process.env.HIG_OUTPUTS_ROOT);
  await fs.mkdir(root, { recursive: true });
  return root;
}
