import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';

const entrypoints = [
  'src/cli/main.ts',
  'src/scripts/application-release.ts',
  'src/scripts/local-acceptance-evidence.ts',
  'src/scripts/ops-maintenance.ts',
] as const;

interface CoverageMetric {
  total: number;
  covered: number;
  skipped: number;
  pct: number;
}

interface CoverageSummary {
  lines: CoverageMetric;
  statements: CoverageMetric;
  functions: CoverageMetric;
  branches: CoverageMetric;
}

const projectRoot = process.cwd();
const rawCoverageDirectory = resolve('.cache/vitest-subprocess-coverage');
const reportsDirectory = resolve('coverage/subprocess');
const c8Bin = resolve('node_modules/c8/bin/c8.js');
const inProcessCoveragePath = resolve('coverage/coverage-final.json');
const inProcessEntrypoints = [
  'src/scripts/application-release.ts',
  'src/scripts/local-acceptance-evidence.ts',
] as const;

assertInProcessCoverage();

if (!existsSync(rawCoverageDirectory)) {
  throw new Error('Subprocess V8 coverage directory does not exist.');
}
rmSync(reportsDirectory, { recursive: true, force: true });
const result = spawnSync(
  process.execPath,
  [
    c8Bin,
    'report',
    `--temp-directory=${rawCoverageDirectory}`,
    ...entrypoints.flatMap((entrypoint) => [`--include=${entrypoint}`]),
    '--exclude-after-remap',
    '--reporter=json-summary',
    `--reports-dir=${reportsDirectory}`,
    '--check-coverage',
    '--lines=82',
    '--statements=82',
    '--functions=82',
    '--branches=75',
  ],
  { cwd: projectRoot, encoding: 'utf8' },
);

if (result.status !== 0) {
  process.stderr.write(result.stderr || result.stdout || 'Subprocess coverage report failed.\n');
  process.exitCode = 1;
} else {
  const summaryPath = resolve(reportsDirectory, 'coverage-summary.json');
  if (!existsSync(summaryPath)) {
    throw new Error('Subprocess coverage summary was not generated.');
  }

  const summary = JSON.parse(readFileSync(summaryPath, 'utf8')) as Record<string, CoverageSummary>;
  const observed = new Map<string, CoverageSummary>();
  for (const [filename, metrics] of Object.entries(summary)) {
    if (filename === 'total') {
      continue;
    }
    const absolute = isAbsolute(filename) ? filename : resolve(filename);
    observed.set(relative(projectRoot, absolute), metrics);
  }

  for (const entrypoint of entrypoints) {
    const metrics = observed.get(entrypoint);
    if (!metrics) {
      throw new Error(`Subprocess coverage omitted required entrypoint: ${entrypoint}`);
    }
    for (const metric of ['lines', 'statements', 'functions', 'branches'] as const) {
      if (metrics[metric].total === 0 || metrics[metric].covered === 0) {
        throw new Error(`Subprocess coverage is empty for ${entrypoint} (${metric}).`);
      }
    }
  }

  process.stdout.write(
    `${JSON.stringify({
      files: entrypoints.length,
      thresholds: { lines: 82, statements: 82, functions: 82, branches: 75 },
      coverage: summary.total,
    })}\n`,
  );
}

function assertInProcessCoverage(): void {
  if (!existsSync(inProcessCoveragePath)) {
    throw new Error('Vitest coverage map does not exist.');
  }

  const coverage = JSON.parse(readFileSync(inProcessCoveragePath, 'utf8')) as Record<
    string,
    { s: Record<string, number>; f: Record<string, number>; b: Record<string, number[]> }
  >;
  for (const entrypoint of inProcessEntrypoints) {
    const metrics = coverage[resolve(entrypoint)];
    if (!metrics) {
      throw new Error(`Vitest coverage omitted imported entrypoint APIs: ${entrypoint}`);
    }
    const counts = [
      ...Object.values(metrics.s),
      ...Object.values(metrics.f),
      ...Object.values(metrics.b).flat(),
    ];
    if (counts.length === 0 || counts.every((count) => count === 0)) {
      throw new Error(`Vitest coverage is empty for imported entrypoint APIs: ${entrypoint}`);
    }
  }
}
