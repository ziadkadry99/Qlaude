import { spawn, ChildProcess } from "child_process";
import { ClaudianSettings, buildToolsList, buildPermissionInstructions } from "./settings";

export interface ToolUseEvent {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResultEvent {
  tool_use_id: string;
  content: string;
}

export interface ClaudeRunnerCallbacks {
  onText: (text: string) => void;
  onToolUse: (event: ToolUseEvent) => void;
  onToolResult: (event: ToolResultEvent) => void;
  onSystemInit: (sessionId: string, tools: string[]) => void;
  onDone: (turns: number, costUsd: number) => void;
  onError: (message: string) => void;
}

export interface ClaudeRunner {
  kill: () => void;
}

export interface RunClaudeOptions {
  prompt: string;
  vaultPath: string;
  currentFilePath: string | null;
  settings: ClaudianSettings;
  callbacks: ClaudeRunnerCallbacks;
  sessionId?: string;
  quickAction?: boolean;
}

export function buildSystemPrompt(
  vaultPath: string,
  currentFilePath: string | null,
  settings: ClaudianSettings,
  quickAction?: boolean
): string {
  const lines: string[] = [];

  lines.push("You are Claude Code running inside Obsidian, a note-taking application.");
  lines.push("");
  lines.push("## Vault Context");
  lines.push("");
  lines.push(`Vault root: ${vaultPath}`);

  if (currentFilePath) {
    lines.push(`Currently active file: ${currentFilePath}`);
  } else {
    lines.push("Currently active file: (none)");
  }

  lines.push("");
  lines.push("## File Path Guidelines");
  lines.push("");
  lines.push(
    "- All file paths should be relative to the vault root (e.g., \"Notes/foo.md\", not absolute paths)"
  );
  lines.push(
    "- Obsidian notes use the Markdown format (.md extension)"
  );
  lines.push(
    "- Internal links between notes use [[wikilink]] syntax (double square brackets)"
  );
  lines.push(
    "- Tags in Obsidian start with # (e.g., #project, #todo)"
  );
  lines.push(
    "- YAML frontmatter at the top of a file (between --- delimiters) stores note metadata"
  );
  lines.push("");

  lines.push(buildPermissionInstructions(settings, currentFilePath));

  if (quickAction) {
    lines.push("");
    lines.push("## Mode");
    lines.push("");
    lines.push(
      "You are operating in quick-action mode. The user cannot send follow-up messages — " +
      "this is a single-shot request. If the request involves making changes to files, " +
      "carry out those changes directly without asking for confirmation. " +
      "Do not say \"Should I proceed?\" or \"Would you like me to...?\" — just do it. " +
      "If a request is genuinely ambiguous and you cannot act without more information, " +
      "state your assumption briefly and act on it."
    );
  }

  return lines.join("\n");
}

export function parseAndDispatch(
  line: string,
  callbacks: ClaudeRunnerCallbacks
): void {
  if (!line.trim()) return;

  let event: Record<string, unknown>;
  try {
    event = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return;
  }

  const type = event.type as string;

  if (type === "system") {
    const subtype = event.subtype as string;
    if (subtype === "init") {
      const sessionId = event.session_id as string;
      const tools = (event.tools as Array<{ name: string }> | undefined)?.map(
        (t) => t.name
      ) ?? [];
      callbacks.onSystemInit(sessionId, tools);
    }
    return;
  }

  if (type === "assistant") {
    const message = event.message as {
      content: Array<Record<string, unknown>>;
    };
    if (!message?.content) return;

    for (const block of message.content) {
      const blockType = block.type as string;
      if (blockType === "text") {
        const text = block.text as string;
        if (text) callbacks.onText(text);
      } else if (blockType === "tool_use") {
        callbacks.onToolUse({
          id: block.id as string,
          name: block.name as string,
          input: (block.input as Record<string, unknown>) ?? {},
        });
      }
    }
    return;
  }

  if (type === "user") {
    const message = event.message as {
      content: Array<Record<string, unknown>>;
    };
    if (!message?.content) return;

    for (const block of message.content) {
      const blockType = block.type as string;
      if (blockType === "tool_result") {
        const rawContent = block.content;
        let contentStr: string;
        if (typeof rawContent === "string") {
          contentStr = rawContent;
        } else if (Array.isArray(rawContent)) {
          contentStr = (rawContent as Array<{ text?: string }>)
            .map((c) => c.text ?? "")
            .join("\n");
        } else {
          contentStr = JSON.stringify(rawContent);
        }
        callbacks.onToolResult({
          tool_use_id: block.tool_use_id as string,
          content: contentStr,
        });
      }
    }
    return;
  }

  if (type === "result") {
    const subtype = event.subtype as string;
    if (subtype === "success") {
      const turns = (event.num_turns as number) ?? 0;
      const cost = (event.cost_usd as number) ?? 0;
      callbacks.onDone(turns, cost);
    } else if (subtype === "error") {
      const error = event.error as string | undefined;
      callbacks.onError(error ?? "Unknown error from Claude");
    }
    return;
  }
}

export function runClaude(options: RunClaudeOptions): ClaudeRunner {
  const { prompt, vaultPath, currentFilePath, settings, callbacks, sessionId, quickAction } = options;

  const tools = buildToolsList(settings);
  const systemPrompt = buildSystemPrompt(vaultPath, currentFilePath, settings, quickAction);

  const args: string[] = [
    "-p",
    prompt,
    "--output-format",
    "stream-json",
    "--verbose",
    "--model",
    settings.model,
    "--system-prompt",
    systemPrompt,
    "--allowedTools",
    tools.join(","),
    "--dangerously-skip-permissions",
  ];

  if (sessionId) {
    args.push("--resume", sessionId);
  }

  const env = { ...process.env };
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE;

  let proc: ChildProcess;
  try {
    proc = spawn(settings.claudeBinaryPath, args, {
      cwd: vaultPath,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    const error = err as NodeJS.ErrnoException;
    if (error.code === "ENOENT") {
      callbacks.onError(
        `Claude binary not found at "${settings.claudeBinaryPath}". ` +
          `Please check the binary path in Claudian settings.`
      );
    } else {
      callbacks.onError(`Failed to start Claude: ${error.message}`);
    }
    return { kill: () => {} };
  }

  let buffer = "";

  proc.stdout?.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      parseAndDispatch(line, callbacks);
    }
  });

  proc.stderr?.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf8").trim();
    const lower = text.toLowerCase();
    if (lower.includes("error") || lower.includes("failed")) {
      callbacks.onError(text);
    }
  });

  proc.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT") {
      callbacks.onError(
        `Claude binary not found at "${settings.claudeBinaryPath}". ` +
          `Please check the binary path in Claudian settings.`
      );
    } else {
      callbacks.onError(`Process error: ${err.message}`);
    }
  });

  proc.on("close", (code: number | null) => {
    // Flush any remaining buffer content
    if (buffer.trim()) {
      parseAndDispatch(buffer, callbacks);
    }
    // If process exited with non-zero and we haven't called onDone yet,
    // it means something went wrong silently
    if (code !== 0 && code !== null) {
      // Only emit if not already handled via result event
    }
  });

  return {
    kill: () => {
      try {
        proc.kill("SIGTERM");
      } catch {
        // Process may already be dead
      }
    },
  };
}
