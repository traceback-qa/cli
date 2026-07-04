import type { Command } from 'commander';
import type { CliContext } from './context.js';

export type CommandRegisterFn = (program: Command, ctx: CliContext) => void;

export interface CommandModule {
  register: CommandRegisterFn;
  name: string;
}
