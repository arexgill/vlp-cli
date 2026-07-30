import ast
import json
import sys

STOP_WORDS = {
    'the', 'a', 'an', 'to', 'of', 'and', 'or', 'is', 'it', 'this', 'that',
    'with', 'from', 'for', 'then', 'when', 'into', 'without', 'must', 'should'
}


def normalize_word(word):
    if len(word) > 4 and word.endswith('ies'):
        return word[:-3] + 'y'
    if len(word) > 4 and word.endswith('s'):
        return word[:-1]
    return word


def keywords_from(text):
    source = str(text or '').lower()
    words = []
    current = []

    for char in source:
        if ('a' <= char <= 'z') or ('0' <= char <= '9') or char == '_':
            current.append(char)
            continue
        if current:
            word = normalize_word(''.join(current))
            if len(word) > 2 and word not in STOP_WORDS and word not in words:
                words.append(word)
            current = []

    if current:
        word = normalize_word(''.join(current))
        if len(word) > 2 and word not in STOP_WORDS and word not in words:
            words.append(word)

    if 'not ' in source or source.startswith('not'):
        for extra in ['empty', 'absent']:
            if extra not in words:
                words.append(extra)
    if 'lower(' in source or '.lower' in source or 'lowercase' in source or 'case-insensitive' in source:
        for extra in ['case', 'insensitive']:
            if extra not in words:
                words.append(extra)
    if 'match' in source or 'includes' in source or ' in ' in source:
        for extra in ['match', 'matching']:
            if extra not in words:
                words.append(extra)

    return words


def node_source(source, node):
    if node is None or not hasattr(node, 'lineno'):
        return ''

    lines = source.splitlines()
    line_index = (getattr(node, 'lineno', 1) or 1) - 1
    if line_index < 0 or line_index >= len(lines):
        return ''

    line = lines[line_index]
    start = getattr(node, 'col_offset', 0) or 0
    end = getattr(node, 'end_col_offset', None)
    if isinstance(end, int) and getattr(node, 'end_lineno', node.lineno) == node.lineno:
        return line[start:end].strip()
    return line[start:].strip()


def first_line(text):
    return str(text or '').splitlines()[0].strip() if text else ''


def expression_text(source, node):
    text = node_source(source, node)
    if text:
        return text
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        base = expression_text(source, node.value)
        return (base + '.' if base else '') + node.attr
    return ''


def signature_details(source, node):
    lines = source.splitlines()
    start = (getattr(node, 'lineno', 1) or 1) - 1
    stop = min(len(lines), start + len(getattr(node, 'decorator_list', [])) + 4)

    for index in range(start, stop):
        stripped = lines[index].strip()
        if stripped.startswith('def ') or stripped.startswith('async def '):
            if stripped.endswith(':'):
                stripped = stripped[:-1]
            return stripped, index + 1

    code = first_line(node_source(source, node))
    if code.endswith(':'):
        code = code[:-1]
    return code, getattr(node, 'lineno', 1) or 1


def make_unit(units, file_path, symbol, kind, node, text, code, line_start=None, line_end=None):
    line_start = line_start or getattr(node, 'lineno', 1) or 1
    line_end = line_end or getattr(node, 'end_lineno', line_start) or line_start
    unit = {
        'id': 'doc-' + str(len(units) + 1),
        'file': file_path,
        'symbol': symbol,
        'kind': kind,
        'lineStart': line_start,
        'lineEnd': line_end,
        'text': text,
        'code': code,
        'keywords': keywords_from(text + ' ' + code),
    }
    units.append(unit)


def module_summary(tree):
    imports = 0
    classes = 0
    functions = 0
    for node in tree.body:
        if isinstance(node, (ast.Import, ast.ImportFrom)):
            imports += 1
        elif isinstance(node, ast.ClassDef):
            classes += 1
        elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            functions += 1
    return f'Module contains {imports} imports, {classes} classes, and {functions} functions.'


def walk(node, source, file_path, units, active_symbol):
    symbol = active_symbol

    if isinstance(node, ast.ClassDef):
        symbol = node.name
        make_unit(units, file_path, symbol, 'class', node, f'Class {node.name} is defined.', first_line(node_source(source, node)))
        for decorator in node.decorator_list:
            decorator_code = '@' + expression_text(source, decorator)
            make_unit(units, file_path, symbol, 'decorator', decorator, f'{symbol} uses decorator {decorator_code}.', decorator_code)

    if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
        symbol = node.name
        code, signature_line = signature_details(source, node)
        make_unit(
            units,
            file_path,
            symbol,
            'signature',
            node,
            f'{symbol} is defined as {code}.',
            code,
            line_start=signature_line,
            line_end=signature_line,
        )
        for decorator in node.decorator_list:
            decorator_code = '@' + expression_text(source, decorator)
            make_unit(units, file_path, symbol, 'decorator', decorator, f'{symbol} uses decorator {decorator_code}.', decorator_code)

    if isinstance(node, ast.Import):
        names = ', '.join(alias.name for alias in node.names)
        make_unit(units, file_path, symbol, 'import', node, f'{symbol} imports {names}.', names)

    if isinstance(node, ast.ImportFrom):
        module_name = node.module or ''
        names = ', '.join(alias.name for alias in node.names)
        code = f'{module_name}: {names}' if module_name else names
        make_unit(units, file_path, symbol, 'import', node, f'{symbol} imports {names} from {module_name or "<relative>"}.', code)

    if isinstance(node, (ast.If, ast.IfExp)):
        condition = expression_text(source, node.test).rstrip(':').strip()
        make_unit(units, file_path, symbol, 'condition', node.test, f'When {condition}, execution follows this branch.', condition)

    if isinstance(node, ast.Call):
        call_code = expression_text(source, node)
        callee = expression_text(source, node.func)
        make_unit(units, file_path, symbol, 'call', node, f'{symbol} calls {callee}.', call_code)

    if isinstance(node, ast.Return):
        code = expression_text(source, node.value)
        text = f'{symbol} returns {code}.' if code else f'{symbol} returns without a value.'
        make_unit(units, file_path, symbol, 'return', node, text, code)

    if isinstance(node, ast.Yield):
        code = expression_text(source, node.value)
        text = f'{symbol} yields {code}.' if code else f'{symbol} yields without a value.'
        make_unit(units, file_path, symbol, 'yield', node, text, code)

    if isinstance(node, ast.YieldFrom):
        code = expression_text(source, node.value)
        make_unit(units, file_path, symbol, 'yield', node, f'{symbol} yields from {code}.', code)

    if isinstance(node, ast.Raise):
        code = expression_text(source, node.exc)
        text = f'{symbol} raises {code}.' if code else f'{symbol} re-raises the active exception.'
        make_unit(units, file_path, symbol, 'raise', node, text, code)

    if isinstance(node, ast.ExceptHandler):
        caught = expression_text(source, node.type).split(' as ', 1)[0].rstrip(':').strip() or 'an exception'
        if node.name:
            caught = caught + ' as ' + str(node.name)
        make_unit(units, file_path, symbol, 'catch', node, f'{symbol} catches {caught}.', caught)

    for child in ast.iter_child_nodes(node):
        walk(child, source, file_path, units, symbol)


def analyze_files(files):
    units = []
    diagnostics = []

    for file_data in files:
        file_path = str(file_data.get('path', ''))
        source = str(file_data.get('source', ''))
        try:
            tree = ast.parse(source, filename=file_path)
        except SyntaxError as error:
            diagnostics.append({
                'file': file_path,
                'line': error.lineno or 1,
                'message': 'SyntaxError: ' + str(error.msg),
            })
            continue
        except Exception as error:
            diagnostics.append({
                'file': file_path,
                'line': 1,
                'message': 'ParseError: ' + str(error),
            })
            continue

        make_unit(units, file_path, '<module>', 'module', tree, module_summary(tree), file_path)
        walk(tree, source, file_path, units, '<module>')

    return {
        'units': units,
        'diagnostics': diagnostics,
        'frameworkHints': {},
    }


def main():
    payload = sys.stdin.read()
    if not payload:
        print(json.dumps({'units': [], 'diagnostics': [], 'frameworkHints': {}}))
        return

    try:
        data = json.loads(payload)
    except Exception:
        print(json.dumps({
            'units': [],
            'diagnostics': [{'file': '<input>', 'line': 1, 'message': 'Invalid JSON input'}],
            'frameworkHints': {},
        }))
        return

    files = data.get('files', [])
    if not isinstance(files, list):
        files = []

    print(json.dumps(analyze_files(files)))


if __name__ == '__main__':
    main()
