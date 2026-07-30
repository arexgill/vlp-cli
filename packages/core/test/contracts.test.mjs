import assert from 'node:assert/strict';
import test from 'node:test';

import { buildContractDocument, normalizeContractSlug } from '../src/contracts.mjs';

test('normalizeContractSlug keeps safe names and rejects traversal', () => {
  assert.equal(normalizeContractSlug('Sample Task'), 'sample-task');
  assert.equal(normalizeContractSlug('sample-task'), 'sample-task');
  assert.throws(() => normalizeContractSlug('../escape'), /unsafe contract name/i);
  assert.throws(() => normalizeContractSlug('bad/name'), /unsafe contract name/i);
});

test('buildContractDocument formats draft contracts deterministically', () => {
  const document = buildContractDocument({
    slug: 'sample-task',
    created: '2026-07-30T12:34:56.000Z',
    scope: 'working-tree',
  });

  assert.equal(
    document,
    [
      '---',
      'id: sample-task',
      'status: draft',
      'created: 2026-07-30T12:34:56.000Z',
      'scope: working-tree',
      '---',
      '',
      '## Intent',
      '',
      'Describe the intended behavior.',
      '',
      '## Acceptance Criteria',
      '',
      '- [ ] Capture the expected outcome.',
      '- [ ] Keep the change limited to the working tree.',
      '',
      '## Exclusions',
      '',
      '- None.',
      '',
      '## Context',
      '',
      '- Add any supporting notes here.',
      '',
    ].join('\n'),
  );
});
