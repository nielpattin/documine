import { getApiHttpOrigin } from "../lib/api";

export type AgentModalConfig = {
  title: string;
  hint: string;
  requiresApiKey?: boolean;
  buildInstructions: (apiKey: string | null) => string;
};

function getCliCommandProfile(apiBaseUrl: string) {
  if (import.meta.env.DEV) {
    return {
      command: "documine",
      setupLines: [
        "# Local development CLI. This works from any agent working directory.",
        `DOCUMINE_CLI_PATH="$(curl -fsS ${apiBaseUrl}/api/runtime/cli-path)"`,
        `documine() { node "$DOCUMINE_CLI_PATH" "$@"; }`,
      ],
    };
  }

  return {
    command: "documine",
    setupLines: ["# Install the CLI globally", "pnpm add -g @nielpattin/documine"],
  };
}

export function buildOwnerAgentModal(noteId: string): AgentModalConfig {
  const apiBaseUrl = getApiHttpOrigin();
  const cli = getCliCommandProfile(apiBaseUrl);
  return {
    title: "Agent setup",
    hint: "Generate an owner API key below. It is only shown once. Then copy the fully connected instructions.",
    requiresApiKey: true,
    buildInstructions: (apiKey) =>
      [
        ...cli.setupLines,
        "",
        "# Register this Documine instance using the generated owner API key",
        `${cli.command} register myserver ${apiBaseUrl} ${apiKey || "<generate-api-key-first>"}`,
        "",
        "# Inspect this note without dumping the full markdown",
        `${cli.command} myserver read ${noteId}`,
        `${cli.command} myserver read ${noteId} --range=1:120`,
        `${cli.command} myserver grep ${noteId} "text" --context=20 --max-matches=5`,
        "",
        "# Edit this note with a unified diff patch",
        `${cli.command} myserver apply ${noteId} --patch change.diff --check`,
        `${cli.command} myserver apply ${noteId} --patch change.diff`,
        "",
        "# Comment on quoted text",
        `${cli.command} myserver comment ${noteId} "quoted text" "comment body"`,
        "",
        "# Reply to a specific message",
        `${cli.command} myserver reply ${noteId} <thread-id> <message-id> "reply"`,
        "",
        "# Resolve or reopen a thread",
        `${cli.command} myserver resolve ${noteId} <thread-id>`,
        `${cli.command} myserver reopen ${noteId} <thread-id>`,
        "",
        "# Edit or delete comments",
        `${cli.command} myserver edit-comment ${noteId} <message-id> "new body"`,
        `${cli.command} myserver delete-comment ${noteId} <message-id>`,
        `${cli.command} myserver delete-thread ${noteId} <thread-id>`,
        "",
        "# Full command reference",
        `${cli.command} --help`,
      ].join("\n"),
  };
}

export function buildSharedAgentModal(shareId: string): AgentModalConfig {
  const apiBaseUrl = getApiHttpOrigin();
  const cli = getCliCommandProfile(apiBaseUrl);
  const shareUrl = `${apiBaseUrl}/s/${shareId}`;
  return {
    title: "Agent setup",
    hint: "This shared note does not need an API key. Copy these instructions directly.",
    buildInstructions: () =>
      [
        ...cli.setupLines,
        "",
        "# Register the shared note",
        `${cli.command} register shared ${shareUrl}`,
        "",
        "# Inspect the note without dumping the full markdown",
        `${cli.command} shared read`,
        `${cli.command} shared read --range=1:120`,
        `${cli.command} shared grep "text" --context=20 --max-matches=5`,
        "",
        "# To edit note markdown, use an owner API key and apply a unified diff patch",
        "",
        "# Comment and reply as an agent",
        `${cli.command} shared comment "quoted text" "comment body" --name="My Agent"`,
        `${cli.command} shared reply <thread-id> <message-id> "reply" --name="My Agent"`,
        "",
        "# Full command reference",
        `${cli.command} --help`,
      ].join("\n"),
  };
}
