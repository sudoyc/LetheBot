import { resolve } from 'node:path';

const subprocessCoverageDirectory = resolve('.cache/vitest-subprocess-coverage');

if (process.env.LETHEBOT_SUBPROCESS_COVERAGE === '1') {
  process.env.NODE_V8_COVERAGE = subprocessCoverageDirectory;
}
