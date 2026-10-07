#!/usr/bin/env node
// The source is TypeScript. tsx compiles it as it loads, so there is no build step.
import { register } from 'tsx/esm/api';

register();
const { main } = await import('../src/main.ts');
await main(process.argv.slice(2));
