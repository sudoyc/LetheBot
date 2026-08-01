import { cpSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const sourceDirectory = resolve(scriptDirectory, '../../src/http/governance-browser-assets');
const targetDirectory = resolve(scriptDirectory, '../http/governance-browser-assets');

mkdirSync(targetDirectory, { recursive: true });
cpSync(sourceDirectory, targetDirectory, { recursive: true });
