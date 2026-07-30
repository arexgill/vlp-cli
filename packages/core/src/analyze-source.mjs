import { parse } from '@babel/parser';
import { createHash } from 'node:crypto';

import { analyzePythonSources } from './python-analyzer.mjs';

const STOP_WORDS = new Set([
  'the',
  'a',
  'an',
  'to',
  'of',
  'and',
  'or',
  'is',
  'it',
  'this',
  'that',
  'with',
  'from',
  'for',
  'then',
  'when',
  'into',
  'without',
  'must',
  'should',
]);

function normalizeWord(word) {
  if (word.length > 4 && word.endsWith('ies')) return `${word.slice(0, -3)}y`;
  if (word.length > 4 && word.endsWith('s')) return word.slice(0, -1);
  return word;
}

export function keywordsFrom(text) {
  const source = String(text);
  const words = (source.toLowerCase().match(/[a-z][a-z0-9_]*/g) || [])
    .map(normalizeWord)
    .filter((word) => word.length > 2 && !STOP_WORDS.has(word));

  if (/!\s*[A-Za-z_$][\w$]*/.test(source)) words.push('empty', 'absent');
  if (/toLowerCase|lowercase|case-insensitive/i.test(source)) words.push('case', 'insensitive');
  if (/\.includes\s*\(|\bmatch(?:es|ing)?\b/i.test(source)) words.push('match', 'matching');

  return [...new Set(words)];
}

function sourceSlice(source, node) {
  if (!node || !Number.isInteger(node.start) || !Number.isInteger(node.end)) return '';
  return source.content.slice(node.start, node.end).trim();
}

function symbolName(node, parent, activeSymbol) {
  if (node.id?.name) return node.id.name;
  if (parent?.type === 'VariableDeclarator' && parent.id.type === 'Identifier') {
    return parent.id.name;
  }
  if ((node.type === 'ObjectMethod' || node.type === 'ClassMethod') && node.key) {
    return node.key.name || node.key.value || activeSymbol;
  }
  return activeSymbol || '<anonymous>';
}

function makeUnit(source, symbol, kind, node, text, code) {
  const lineStart = node.loc?.start.line || 1;
  const lineEnd = node.loc?.end.line || lineStart;
  const digest = createHash('sha1')
    .update(`${source.path}:${symbol}:${kind}:${lineStart}:${code}`)
    .digest('hex')
    .slice(0, 12);

  return {
    id: `doc-${digest}`,
    file: source.path,
    symbol,
    kind,
    lineStart,
    lineEnd,
    text,
    code,
    keywords: keywordsFrom(`${text} ${code}`),
  };
}

function calleeName(node, source) {
  return sourceSlice(source, node.callee);
}

function walk(node, parent, source, output, activeSymbol = '<module>') {
  if (!node || typeof node !== 'object') return;

  let symbol = activeSymbol;
  const isFunction = [
    'FunctionDeclaration',
    'FunctionExpression',
    'ArrowFunctionExpression',
    'ObjectMethod',
    'ClassMethod',
  ].includes(node.type);

  if (isFunction) {
    symbol = symbolName(node, parent, activeSymbol);
    const params = node.params.map((param) => sourceSlice(source, param));
    output.push(
      makeUnit(
        source,
        symbol,
        'signature',
        node,
        `${symbol} receives ${params.length ? params.join(', ') : 'no parameters'}.`,
        sourceSlice(source, node).split('\n')[0],
      ),
    );
  }

  if (node.type === 'IfStatement' || node.type === 'ConditionalExpression') {
    const code = sourceSlice(source, node.test);
    output.push(
      makeUnit(source, symbol, 'condition', node.test, `When ${code}, execution follows this branch.`, code),
    );
  }

  if (node.type === 'CallExpression' || node.type === 'OptionalCallExpression') {
    const code = sourceSlice(source, node);
    output.push(makeUnit(source, symbol, 'call', node, `${symbol} calls ${calleeName(node, source)}.`, code));
  }

  if (node.type === 'ReturnStatement') {
    const code = node.argument ? sourceSlice(source, node.argument) : '';
    output.push(
      makeUnit(
        source,
        symbol,
        'return',
        node,
        code ? `${symbol} returns ${code}.` : `${symbol} returns without a value.`,
        code,
      ),
    );
  }

  if (node.type === 'ThrowStatement') {
    const code = sourceSlice(source, node.argument);
    output.push(makeUnit(source, symbol, 'throw', node, `${symbol} throws ${code}.`, code));
  }

  if (node.type === 'CatchClause') {
    const name = node.param ? sourceSlice(source, node.param) : 'an error';
    output.push(makeUnit(source, symbol, 'catch', node, `${symbol} catches ${name}.`, name));
  }

  for (const [key, value] of Object.entries(node)) {
    if (['loc', 'start', 'end', 'extra', 'comments', 'tokens', 'errors'].includes(key)) continue;
    if (Array.isArray(value)) {
      value.forEach((child) => walk(child, node, source, output, symbol));
    } else if (value && typeof value === 'object' && typeof value.type === 'string') {
      walk(value, node, source, output, symbol);
    }
  }
}

function parserPlugins(source) {
  const plugins = [];
  if (source.language === 'typescript') plugins.push('typescript');
  if (source.path.endsWith('.jsx') || source.path.endsWith('.tsx')) plugins.push('jsx');
  return plugins;
}

export async function analyzeSources(sources, options = {}) {
  const docUnits = [];
  const diagnostics = [];
  const pythonSources = [];
  let frameworkHints = {};

  for (const source of sources) {
    if (source.language === 'python') {
      pythonSources.push({ path: source.path, source: source.content });
      continue;
    }

    if (!['javascript', 'typescript'].includes(source.language)) {
      continue;
    }

    try {
      const ast = parse(source.content, {
        sourceType: 'unambiguous',
        plugins: parserPlugins(source),
        errorRecovery: false,
      });
      walk(ast.program, null, source, docUnits);
    } catch (error) {
      diagnostics.push({
        file: source.path,
        message: error.message,
        line: error.loc?.line || 1,
      });
    }
  }

  if (pythonSources.length > 0) {
    const result = await analyzePythonSources(pythonSources, options);
    if (Array.isArray(result.units)) docUnits.push(...result.units);
    if (Array.isArray(result.diagnostics)) diagnostics.push(...result.diagnostics);
    if (result.frameworkHints && typeof result.frameworkHints === 'object') {
      frameworkHints = result.frameworkHints;
    }
  }

  return { docUnits, diagnostics, frameworkHints };
}
