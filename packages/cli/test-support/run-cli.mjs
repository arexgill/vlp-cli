import { run } from '../src/run.mjs';

if (process.env.MONKEYPAW_TEST_RUNNER === '1') {
  const exitCode = await run({
    argv: process.argv.slice(2),
    cwd: process.cwd(),
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
    isTTY: {
      stdin: process.env.MONKEYPAW_TEST_STDIN_TTY === '1',
      stdout: process.env.MONKEYPAW_TEST_STDOUT_TTY === '1',
      stderr: process.env.MONKEYPAW_TEST_STDERR_TTY === '1',
    },
    clock: process.env.MONKEYPAW_TEST_CLOCK ? () => new Date(process.env.MONKEYPAW_TEST_CLOCK) : undefined,
    randomUUID: process.env.MONKEYPAW_TEST_UUID ? () => process.env.MONKEYPAW_TEST_UUID : undefined,
  });

  process.exitCode = exitCode;
}
