import { mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';

const subprocessCoverageDirectory = resolve('.cache/vitest-subprocess-coverage');

export async function setup(): Promise<void> {
  if (process.env.LETHEBOT_SUBPROCESS_COVERAGE !== '1') {
    return;
  }


  await rm(subprocessCoverageDirectory, { recursive: true, force: true });
  await mkdir(subprocessCoverageDirectory, { recursive: true });
}
