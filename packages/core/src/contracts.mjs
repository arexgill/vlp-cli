import path from 'node:path';

export const CONTRACTS_DIR = '.monkeypaw/contracts';
export const CONTRACT_FILE_EXTENSION = '.md';
export const REQUIRED_CONTRACT_SECTIONS = Object.freeze([
  'Intent',
  'Acceptance Criteria',
  'Exclusions',
  'Context',
]);

const DEFAULT_SECTION_CONTENT = Object.freeze({
  Intent: ['Describe the intended behavior.'],
  'Acceptance Criteria': [
    '- [ ] Capture the expected outcome.',
    '- [ ] Keep the change limited to the working tree.',
  ],
  Exclusions: ['- None.'],
  Context: ['- Add any supporting notes here.'],
});

function cleanText(value) {
  return String(value ?? '').replaceAll('\0', '').replace(/\r\n?/g, '\n');
}

function normalizeSectionLines(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => cleanText(entry).replace(/\s+$/u, ''));
  }

  const text = cleanText(value).trimEnd();
  if (!text) {
    return [];
  }

  return text.split('\n').map((line) => line.replace(/\s+$/u, ''));
}

function slugPattern(slug) {
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug);
}

export function normalizeContractSlug(name) {
  const rawName = cleanText(name).trim();
  if (!rawName) {
    throw new Error('Unsafe contract name: a name is required');
  }

  if (/[/\\]/.test(rawName) || /(^|[/\\])\.\.?([/\\]|$)/.test(rawName)) {
    throw new Error('Unsafe contract name: path traversal is not allowed');
  }

  const slug = rawName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  if (!slug || !slugPattern(slug)) {
    throw new Error('Unsafe contract name: name must resolve to a safe slug');
  }

  return slug;
}

export function contractFilePath(root, slug) {
  return path.join(path.resolve(String(root ?? '.')), CONTRACTS_DIR, `${slug}${CONTRACT_FILE_EXTENSION}`);
}

function renderSection(title, lines) {
  const contentLines = normalizeSectionLines(lines);
  if (contentLines.length === 0) {
    throw new Error(`Contract section is empty: ${title}`);
  }

  return [`## ${title}`, '', ...contentLines, ''];
}

export function buildContractDocument({ slug, created, scope = 'working-tree', status = 'draft', sections = DEFAULT_SECTION_CONTENT } = {}) {
  if (!slugPattern(String(slug ?? ''))) {
    throw new Error(`Invalid contract slug: ${slug}`);
  }

  const createdAt = created instanceof Date ? created.toISOString() : cleanText(created).trim();
  if (!createdAt) {
    throw new Error('Contract created timestamp is required');
  }

  const frontMatter = [
    '---',
    `id: ${slug}`,
    `status: ${status}`,
    `created: ${createdAt}`,
    `scope: ${scope}`,
    '---',
    '',
  ];

  const body = [
    ...renderSection('Intent', sections.Intent ?? sections.intent),
    ...renderSection('Acceptance Criteria', sections['Acceptance Criteria'] ?? sections.acceptanceCriteria),
    ...renderSection('Exclusions', sections.Exclusions ?? sections.exclusions),
    ...renderSection('Context', sections.Context ?? sections.context),
  ];

  return [...frontMatter, ...body].join('\n');
}

function parseFrontMatter(lines) {
  const frontMatter = {};

  for (const line of lines) {
    if (!line.trim()) {
      continue;
    }

    const separatorIndex = line.indexOf(': ');
    if (separatorIndex < 0) {
      throw new Error('Invalid contract front matter');
    }

    const key = line.slice(0, separatorIndex).trim();
    const value = line.slice(separatorIndex + 2).trim();
    if (frontMatter[key] !== undefined) {
      throw new Error(`Duplicate contract front matter key: ${key}`);
    }

    frontMatter[key] = value;
  }

  const expectedKeys = ['id', 'status', 'created', 'scope'];
  for (const key of Object.keys(frontMatter)) {
    if (!expectedKeys.includes(key)) {
      throw new Error(`Unknown contract front matter key: ${key}`);
    }
  }

  for (const key of expectedKeys) {
    if (!frontMatter[key]) {
      throw new Error(`Missing contract front matter key: ${key}`);
    }
  }

  return frontMatter;
}

function splitSections(body) {
  const sections = new Map();
  const lines = cleanText(body).replace(/\s+$/u, '').split('\n');
  let currentTitle = null;
  let currentLines = [];

  function flush() {
    if (!currentTitle) {
      return;
    }

    const text = currentLines.join('\n').trim();
    if (!text) {
      throw new Error(`Missing required section content: ${currentTitle}`);
    }

    sections.set(currentTitle, text);
  }

  for (const line of lines) {
    const headingMatch = line.match(/^##\s+(.+?)\s*$/u);

    if (headingMatch) {
      flush();
      currentTitle = headingMatch[1];
      currentLines = [];
      continue;
    }

    if (currentTitle === null) {
      if (line.trim()) {
        throw new Error('Contract body must begin with a section heading');
      }
      continue;
    }

    currentLines.push(line);
  }

  flush();

  for (const title of sections.keys()) {
    if (!REQUIRED_CONTRACT_SECTIONS.includes(title)) {
      throw new Error(`Unknown contract section: ${title}`);
    }
  }

  for (const title of REQUIRED_CONTRACT_SECTIONS) {
    if (!sections.has(title)) {
      throw new Error(`Missing required section: ${title}`);
    }
  }

  return Object.freeze(Object.fromEntries(sections.entries()));
}

export function parseContractDocument(content) {
  const text = cleanText(content);
  if (!text.startsWith('---\n')) {
    throw new Error('Contract must begin with front matter');
  }

  const closingFenceIndex = text.indexOf('\n---\n', 4);
  if (closingFenceIndex < 0) {
    throw new Error('Contract front matter must be closed with ---');
  }

  const frontMatterLines = text.slice(4, closingFenceIndex).split('\n');
  const frontMatter = parseFrontMatter(frontMatterLines);
  const body = text.slice(closingFenceIndex + 5);
  const sections = splitSections(body);

  if (!slugPattern(frontMatter.id)) {
    throw new Error(`Invalid contract slug: ${frontMatter.id}`);
  }

  return Object.freeze({
    slug: frontMatter.id,
    status: frontMatter.status,
    created: frontMatter.created,
    scope: frontMatter.scope,
    sections,
    content: `${text.endsWith('\n') ? text : `${text}\n`}`,
  });
}

export async function readContractDocument(root, slug, reader) {
  const { readFile } = await import('node:fs/promises');
  const filePath = contractFilePath(root, slug);
  const content = await (reader || readFile)(filePath, 'utf8');
  return Object.freeze({
    path: path.relative(path.resolve(String(root ?? '.')), filePath).split(path.sep).join('/'),
    filePath,
    ...parseContractDocument(content),
  });
}
