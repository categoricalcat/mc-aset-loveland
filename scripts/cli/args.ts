import { parseArgs, type ParseArgsOptionsConfig } from 'util';

export const DEFAULT_GAME = '26.3';

export const CLI_USAGE = [
  'usage:',
  '  pack update [--preserve] [--game <version>] [pack]',
  '  pack process [--write-index] [pack]',
].join('\n');

type CliCommand =
  | { command: 'help' }
  | {
      command: 'process';
      pack: string;
      writeIndex: boolean;
    }
  | {
      command: 'update';
      game: string;
      pack: string;
      preserveOriginalRoots: boolean;
    };

interface CommandSpec {
  build: (
    values: Readonly<
      Record<string, (boolean | string)[] | boolean | string | undefined>
    >,
    pack: string,
  ) => CliCommand;
  options: ParseArgsOptionsConfig;
}

export class UsageError extends Error {
  constructor(detail?: string) {
    super(detail === undefined ? CLI_USAGE : `${detail}\n${CLI_USAGE}`);
    this.name = 'UsageError';
  }
}

const commands: Record<string, CommandSpec> = {
  process: {
    build: (values, pack) => ({
      command: 'process',
      pack,
      writeIndex: values['write-index'] === true,
    }),
    options: {
      'write-index': { type: 'boolean' },
    },
  },
  update: {
    build: (values, pack) => {
      const game =
        typeof values['game'] === 'string' ? values['game'] : DEFAULT_GAME;
      if (game === '') throw new UsageError('--game needs a version');
      return {
        command: 'update',
        game,
        pack,
        preserveOriginalRoots: values['preserve'] === true,
      };
    },
    options: {
      game: { type: 'string' },
      preserve: { type: 'boolean' },
    },
  },
};

export const parseCli = (argv: readonly string[]): CliCommand => {
  const [name = '', ...rest] = argv[0] === '--' ? argv.slice(1) : argv;
  if (name === 'help' || name === '--help' || name === '-h') {
    return { command: 'help' };
  }
  const spec = Object.hasOwn(commands, name) ? commands[name] : undefined;
  if (spec === undefined) {
    throw new UsageError(name === '' ? undefined : `unknown command ${name}`);
  }

  let parsed;
  try {
    parsed = parseArgs({
      allowPositionals: true,
      args: rest,
      options: { ...spec.options, help: { short: 'h', type: 'boolean' } },
      strict: true,
    });
  } catch (caught) {
    throw new UsageError(caught instanceof Error ? caught.message : undefined);
  }
  if (parsed.values.help === true) return { command: 'help' };

  const [pack = 'bias', ...extra] = parsed.positionals;
  if (extra.length > 0 || pack === '') {
    throw new UsageError('expected at most one non-empty pack name');
  }
  return spec.build(parsed.values, pack);
};
