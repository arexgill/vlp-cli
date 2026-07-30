function nextValue(argv, index, flag) {
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`Missing value for ${flag}`);
  }
  return value;
}

function assertNoExtra(argv, index) {
  if (index < argv.length) {
    throw new Error(`Unexpected argument: ${argv[index]}`);
  }
}

export function helpText() {
  return [
    'vlp <command>',
    'vlp review',
    '',
    'Commands:',
    '  init',
    '  contract new <name> [--force]',
    '  contract confirm <name>',
    '  review [--contract <name>] [--staged] [--base <ref>] [--json|--web [--no-open]]',
    '  resolve --session <id> --input <path|-> --json',
    '  status',
    '  doctor',
    '  --version',
    '  --help',
    '',
  ].join('\n');
}

export function parseArgs(argv = []) {
  const args = [...argv];
  const first = args[0];

  if (!first || first === '--help' || first === 'help') {
    return { command: 'help' };
  }

  if (first === '--version' || first === 'version') {
    return { command: 'version' };
  }

  if (first === 'init') {
    assertNoExtra(args, 1);
    return { command: 'init' };
  }

  if (first === 'contract') {
    const action = args[1];
    if (!['new', 'confirm'].includes(action)) {
      throw new Error('Contract command requires new or confirm');
    }

    const name = args[2];
    if (!name) {
      throw new Error(`contract ${action} requires a name`);
    }

    let force = false;
    for (let index = 3; index < args.length; index += 1) {
      if (args[index] === '--force' && action === 'new') {
        force = true;
        continue;
      }
      throw new Error(`Unexpected argument: ${args[index]}`);
    }

    return { command: 'contract', action, name, force };
  }

  if (first === 'review') {
    let contract = null;
    let staged = false;
    let base = null;
    let json = false;
    let web = false;
    let noOpen = false;

    for (let index = 1; index < args.length; index += 1) {
      const value = args[index];
      if (value === '--contract') {
        contract = nextValue(args, index, value);
        index += 1;
        continue;
      }
      if (value === '--base') {
        base = nextValue(args, index, value);
        index += 1;
        continue;
      }
      if (value === '--staged') {
        staged = true;
        continue;
      }
      if (value === '--json') {
        json = true;
        continue;
      }
      if (value === '--web') {
        web = true;
        continue;
      }
      if (value === '--no-open') {
        noOpen = true;
        continue;
      }
      throw new Error(`Unexpected argument: ${value}`);
    }

    if (json && web) {
      throw new Error('review cannot use --json and --web together');
    }
    if (noOpen && !web) {
      throw new Error('review --no-open requires --web');
    }

    return { command: 'review', contract, staged, base, json, web, noOpen };
  }

  if (first === 'resolve') {
    let session = null;
    let input = null;
    let json = false;

    for (let index = 1; index < args.length; index += 1) {
      const value = args[index];
      if (value === '--session') {
        session = nextValue(args, index, value);
        index += 1;
        continue;
      }
      if (value === '--input') {
        input = nextValue(args, index, value);
        index += 1;
        continue;
      }
      if (value === '--json') {
        json = true;
        continue;
      }
      throw new Error(`Unexpected argument: ${value}`);
    }

    if (!session) throw new Error('resolve requires --session <id>');
    if (!input) throw new Error('resolve requires --input <path|->');
    if (!json) throw new Error('resolve requires --json');

    return { command: 'resolve', session, input, json };
  }

  if (first === 'status') {
    assertNoExtra(args, 1);
    return { command: 'status' };
  }

  if (first === 'doctor') {
    assertNoExtra(args, 1);
    return { command: 'doctor' };
  }

  throw new Error(`Unknown command: ${first}`);
}
