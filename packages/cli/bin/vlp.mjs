#!/usr/bin/env node

import { run } from '../src/run.mjs';

process.exitCode = await run();
