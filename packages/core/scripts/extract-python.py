import ast
import json
import sys

STOP_WORDS = {
    'the', 'a', 'an', 'to', 'of', 'and', 'or', 'is', 'it', 'this', 'that',
    'with', 'from', 'for', 'then', 'when', 'into', 'without', 'must', 'should'
}
SCALAR_TYPES = {'int', 'str', 'float', 'bool', 'bytes'}
IGNORE_TYPES = {'Request', 'Response', 'BackgroundTasks', 'Session'}
ROUTE_METHODS = {'get', 'post', 'put', 'patch', 'delete', 'options', 'head', 'api_route'}


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


def simple_name(node):
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        base = simple_name(node.value)
        return (base + '.' if base else '') + node.attr
    if isinstance(node, ast.Call):
        return simple_name(node.func)
    return ''


def call_name(node):
    if isinstance(node, ast.Call):
        return call_name(node.func)
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        return node.attr
    return ''


def constant_value(node, default=''):
    if isinstance(node, ast.Constant):
        return node.value
    if isinstance(node, ast.Str):
        return node.s
    if isinstance(node, ast.Num):
        return node.n
    return default


def annotation_name(node):
    if node is None:
        return ''
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        return node.attr
    if isinstance(node, ast.Subscript):
        inner = getattr(node, 'slice', None)
        if hasattr(ast, 'Index') and isinstance(inner, getattr(ast, 'Index')):
            inner = inner.value
        name = annotation_name(inner)
        if name:
            return name
        return annotation_name(node.value)
    if isinstance(node, ast.Tuple):
        for element in node.elts:
            name = annotation_name(element)
            if name:
                return name
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return node.value
    return ''


def is_dependency_call(node):
    return isinstance(node, ast.Call) and call_name(node) == 'Depends'


def route_prefix_value(node):
    prefix = ''
    for kw in getattr(node, 'keywords', []):
        if kw.arg == 'prefix':
            value = constant_value(kw.value, '')
            prefix = str(value or '')
    return prefix


def normalize_path(*parts):
    joined = ''.join(str(part or '') for part in parts)
    segments = [segment for segment in joined.split('/') if segment]
    if not segments:
        return '/'
    return '/' + '/'.join(segments)


def first_target_name(target):
    if isinstance(target, ast.Name):
        return target.id
    return ''


def collect_router_metadata(tree, source):
    routers = {}
    inclusions = {}

    for node in ast.walk(tree):
        if isinstance(node, ast.Assign) and isinstance(node.value, ast.Call):
            target_name = call_name(node.value)
            if target_name == 'APIRouter':
                prefix = route_prefix_value(node.value)
                for target in node.targets:
                    name = first_target_name(target)
                    if name:
                        routers[name] = prefix

        if isinstance(node, ast.AnnAssign) and isinstance(node.value, ast.Call):
            target_name = call_name(node.value)
            if target_name == 'APIRouter' and isinstance(node.target, ast.Name):
                routers[node.target.id] = route_prefix_value(node.value)

        if isinstance(node, ast.Expr) and isinstance(node.value, ast.Call):
            call = node.value
            if isinstance(call.func, ast.Attribute) and call.func.attr == 'include_router':
                parent_name = simple_name(call.func.value)
                child_name = ''
                if call.args:
                    child_name = simple_name(call.args[0])
                if parent_name and child_name:
                    prefix = ''
                    for kw in call.keywords:
                        if kw.arg == 'prefix':
                            value = constant_value(kw.value, '')
                            prefix = str(value or '')
                    inclusions.setdefault(child_name, []).append((parent_name, prefix))

    return routers, inclusions


def composite_prefixes(router_name, routers, inclusions, visited=None):
    if not router_name:
        return ['']
    if visited is None:
        visited = set()
    if router_name in visited:
        return []

    visited.add(router_name)
    router_prefix = routers.get(router_name, '')
    parents = inclusions.get(router_name, [])
    if not parents:
        visited.remove(router_name)
        return [router_prefix] if router_prefix else ['']

    result = []
    for parent_name, include_prefix in parents:
        parent_prefixes = composite_prefixes(parent_name, routers, inclusions, visited)
        for parent_prefix in parent_prefixes:
            result.append(normalize_path(parent_prefix, include_prefix, router_prefix))

    visited.remove(router_name)

    if result:
        unique = []
        for value in result:
            if value not in unique:
                unique.append(value)
        return unique

    return [router_prefix] if router_prefix else ['']


def dependency_name(node):
    if not is_dependency_call(node):
        return ''
    if node.args:
        return simple_name(node.args[0]) or annotation_name(node.args[0])
    return ''


def extract_fastapi_routes(tree, source, file_path):
    routers, inclusions = collect_router_metadata(tree, source)
    routes = []
    seen = set()

    for node in ast.walk(tree):
        if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            continue

        for decorator in node.decorator_list:
            if not (isinstance(decorator, ast.Call) and isinstance(decorator.func, ast.Attribute)):
                continue

            method = decorator.func.attr
            if method not in ROUTE_METHODS:
                continue

            router_name = simple_name(decorator.func.value)
            route_path = ''
            if decorator.args:
                route_path = str(constant_value(decorator.args[0], '') or '')

            methods = []
            if method == 'api_route':
                for kw in decorator.keywords:
                    if kw.arg == 'methods' and isinstance(kw.value, (ast.List, ast.Tuple, ast.Set)):
                        for elt in kw.value.elts:
                            value = constant_value(elt, '')
                            if value:
                                upper = str(value).upper()
                                if upper not in methods:
                                    methods.append(upper)
                if not methods:
                    methods = ['GET']
            else:
                methods = [method.upper()]

            dependencies = []
            status_code = None
            response_model = None

            for kw in decorator.keywords:
                if kw.arg == 'status_code':
                    status_code = constant_value(kw.value, None)
                elif kw.arg == 'response_model':
                    response_model = annotation_name(kw.value) or simple_name(kw.value)
                elif kw.arg == 'dependencies' and isinstance(kw.value, (ast.List, ast.Tuple)):
                    for elt in kw.value.elts:
                        if is_dependency_call(elt):
                            name = ''
                            if elt.args:
                                name = simple_name(elt.args[0]) or annotation_name(elt.args[0])
                            if name and name not in dependencies:
                                dependencies.append(name)

            positional_args = list(getattr(node.args, 'posonlyargs', [])) + list(node.args.args)
            defaults = list(node.args.defaults)
            defaults_start = len(positional_args) - len(defaults)
            request_model = None
            for index, arg in enumerate(positional_args):
                default = defaults[index - defaults_start] if index >= defaults_start else None
                if is_dependency_call(default):
                    name = dependency_name(default)
                    if name and name not in dependencies:
                        dependencies.append(name)
                    continue

                type_name = annotation_name(arg.annotation)
                if type_name and type_name not in SCALAR_TYPES and type_name not in IGNORE_TYPES:
                    request_model = type_name
                    break

            for prefix in composite_prefixes(router_name, routers, inclusions):
                full_path = normalize_path(prefix, route_path)
                key = (
                    file_path,
                    node.lineno,
                    full_path,
                    ','.join(methods),
                    status_code,
                    response_model,
                    ','.join(dependencies),
                    request_model,
                )
                if key in seen:
                    continue
                seen.add(key)
                routes.append({
                    'file': file_path,
                    'lineStart': node.lineno,
                    'path': full_path,
                    'methods': methods,
                    'dependencies': dependencies,
                    'requestModel': request_model,
                    'responseModel': response_model,
                    'statusCode': status_code,
                })

    routes.sort(key=lambda route: (route['file'], route['lineStart'], route['path'], ','.join(route['methods'])))
    return routes


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
    fastapi_routes = []

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

        fastapi_routes.extend(extract_fastapi_routes(tree, source, file_path))
        make_unit(units, file_path, '<module>', 'module', tree, module_summary(tree), file_path)
        walk(tree, source, file_path, units, '<module>')

    framework_hints = {}
    if fastapi_routes:
        framework_hints['fastapiRoutes'] = fastapi_routes

    return {
        'units': units,
        'diagnostics': diagnostics,
        'frameworkHints': framework_hints,
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
