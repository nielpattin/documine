import { getApiHttpOrigin } from '../lib/api';

export type AgentModalConfig = {
  title: string;
  hint: string;
  requiresApiKey?: boolean;
  buildInstructions: (apiKey: string | null) => string;
};

export function buildOwnerAgentModal(noteId: string): AgentModalConfig {
  const apiBaseUrl = getApiHttpOrigin();
  return {
    title: 'Agent setup',
    hint: 'Generate an owner API key below. It is only shown once. Then copy the fully connected instructions.',
    requiresApiKey: true,
    buildInstructions: (apiKey) => [
      '# Install the CLI globally',
      `npm i -g @nielpattin/documine`,
      '',
      '# Register this Documine instance using the generated owner API key',
      `documine register myserver ${apiBaseUrl} ${apiKey || '<generate-api-key-first>'}`,
      '',
      '# Read this note',
      `documine myserver read ${noteId}`,
      '',
      '# Edit this note',
      `documine myserver edit ${noteId} '[{"oldText":"...","newText":"..."}]'`,
      '',
      '# Comment on quoted text',
      `documine myserver comment ${noteId} "quoted text" "comment body"`,
      '',
      '# Reply to a specific message',
      `documine myserver reply ${noteId} <thread-id> <message-id> "reply"`,
      '',
      '# Resolve or reopen a thread',
      `documine myserver resolve ${noteId} <thread-id>`,
      `documine myserver reopen ${noteId} <thread-id>`,
      '',
      '# Edit or delete comments',
      `documine myserver edit-comment ${noteId} <message-id> "new body"`,
      `documine myserver delete-comment ${noteId} <message-id>`,
      `documine myserver delete-thread ${noteId} <thread-id>`,
      '',
      '# Full command reference',
      `documine --help`,
    ].join('\n'),
  };
}

export function buildSharedAgentModal(shareId: string): AgentModalConfig {
  const apiBaseUrl = getApiHttpOrigin();
  const shareUrl = `${apiBaseUrl}/s/${shareId}`;
  return {
    title: 'Agent setup',
    hint: 'This shared note does not need an API key. Copy these instructions directly.',
    buildInstructions: () => [
      '# Install the CLI globally',
      `npm i -g @nielpattin/documine`,
      '',
      '# Register the shared note',
      `documine register shared ${shareUrl}`,
      '',
      '# Read the note',
      `documine shared read`,
      '',
      '# Edit the note if edit access is enabled',
      `documine shared edit '[{"oldText":"...","newText":"..."}]'`,
      '',
      '# Comment and reply as an agent',
      `documine shared comment "quoted text" "comment body" --name="My Agent"`,
      `documine shared reply <thread-id> <message-id> "reply" --name="My Agent"`,
      '',
      '# Full command reference',
      `documine --help`,
    ].join('\n'),
  };
}
