export const prompt: string;
export type LabelPromptOptions = {
  nodePath: string;
  cliPath: string;
  port?: number;
  platform?: string;
  id?: string;
  ids?: string[];
  folder?: string;
  scope?: 'direct' | 'children' | 'recursive';
  limit?: number;
  retry?: boolean;
};
export function labelCommand(options: LabelPromptOptions, command: string, args?: string[]): string;
export function buildPrompt(options: LabelPromptOptions): string;
