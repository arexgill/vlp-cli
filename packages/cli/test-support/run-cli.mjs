import { run } from '../src/run.mjs';

if (process.env.VLP_TEST_RUNNER === '1') {
  const exitCode = await run({
    argv: process.argv.slice(2),
    cwd: process.cwd(),
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
    isTTY: {
      stdin: process.env.VLP_TEST_STDIN_TTY === '1',
      stdout: process.env.VLP_TEST_STDOUT_TTY === '1',
      stderr: process.env.VLP_TEST_STDERR_TTY === '1',
    },
    clock: process.env.VLP_TEST_CLOCK ? () => new Date(process.env.VLP_TEST_CLOCK) : undefined,
    randomUUID: process.env.VLP_TEST_UUID ? () => process.env.VLP_TEST_UUID : undefined,
  });

  process.exitCode = exitCode;
}
