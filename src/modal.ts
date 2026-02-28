import { App, Modal, MarkdownRenderer } from "obsidian";
import {
  ClaudeRunner,
  ToolUseEvent,
  ToolResultEvent,
  runClaude,
} from "./claude-runner";
import type { ClaudianSettings } from "./settings";

export interface ChatTurnData {
  userText: string;
  claudeMarkdown: string;
}

export interface ChatStorage {
  load: () => Promise<{ sessionId: string | null; turns: ChatTurnData[] }>;
  save: (sessionId: string | null, turns: ChatTurnData[]) => Promise<void>;
  clear: () => Promise<void>;
}

interface ToolCard {
  toolUse: ToolUseEvent;
  toolResult?: ToolResultEvent;
  cardEl: HTMLElement;
  headerEl: HTMLElement;
  bodyEl: HTMLElement;
  resultEl: HTMLElement;
  isExpanded: boolean;
}

type ModalStatus = "idle" | "running" | "done" | "error" | "cancelled";

export class ClaudianModal extends Modal {
  private settings: ClaudianSettings;
  private vaultPath: string;
  private currentFilePath: string | null;
  private storage: ChatStorage;

  private promptTextarea!: HTMLTextAreaElement;
  private outputEl!: HTMLElement;
  private statusEl!: HTMLElement;
  private runBtn!: HTMLButtonElement;
  private cancelBtn!: HTMLButtonElement;

  // Mode
  private mode: "quick" | "chat" = "quick";
  private quickTabBtn!: HTMLButtonElement;
  private chatTabBtn!: HTMLButtonElement;
  private clearBtn!: HTMLButtonElement;
  private conversationEl!: HTMLElement;

  private runner: ClaudeRunner | null = null;
  private status: ModalStatus = "idle";
  private toolCards: Map<string, ToolCard> = new Map();
  private turns = 0;
  private costUsd = 0;
  private currentTextBlock: HTMLElement | null = null;
  private currentTextContent = "";
  private currentTurnMarkdown = "";  // full markdown for the current chat turn
  private persistedTurns: ChatTurnData[] = [];
  private currentTurnClaudeEl: HTMLElement | null = null;
  private sessionId: string | null = null;
  private loadingIndicatorEl: HTMLElement | null = null;

  constructor(
    app: App,
    settings: ClaudianSettings,
    vaultPath: string,
    currentFilePath: string | null,
    storage: ChatStorage
  ) {
    super(app);
    this.settings = settings;
    this.vaultPath = vaultPath;
    this.currentFilePath = currentFilePath;
    this.storage = storage;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.addClass("claudian-modal");
    this.modalEl.addClass("claudian-modal-outer");

    // Header
    const headerEl = contentEl.createDiv("claudian-header");
    headerEl.createEl("h2", { text: "Claudian", cls: "claudian-title" });
    if (this.currentFilePath) {
      headerEl.createEl("span", {
        text: `Active file: ${this.currentFilePath}`,
        cls: "claudian-active-file",
      });
    } else {
      headerEl.createEl("span", {
        text: "No active file",
        cls: "claudian-active-file claudian-active-file--none",
      });
    }

    // Mode tabs
    const tabsEl = headerEl.createDiv("claudian-mode-tabs");
    this.quickTabBtn = tabsEl.createEl("button", {
      text: "Quick Action",
      cls: "claudian-mode-tab claudian-mode-tab--active",
    });
    this.quickTabBtn.addEventListener("click", () => this.switchMode("quick"));
    this.chatTabBtn = tabsEl.createEl("button", {
      text: "Chat",
      cls: "claudian-mode-tab",
    });
    this.chatTabBtn.addEventListener("click", () => this.switchMode("chat"));

    // Prompt area
    const promptEl = contentEl.createDiv("claudian-prompt-area");
    this.promptTextarea = promptEl.createEl("textarea", {
      cls: "claudian-textarea",
      attr: {
        placeholder: "What should Claude do? (Ctrl+Enter to run)",
        rows: "3",
      },
    });

    this.promptTextarea.addEventListener("keydown", (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
        e.preventDefault();
        this.handleRun();
      }
      if (e.key === "Escape") {
        this.handleCancel();
      }
    });

    // Buttons
    const buttonsEl = contentEl.createDiv("claudian-buttons");

    this.clearBtn = buttonsEl.createEl("button", {
      text: "Clear",
      cls: "claudian-btn claudian-btn--clear",
    });
    this.clearBtn.style.display = "none";
    this.clearBtn.addEventListener("click", () => this.handleClear());

    this.cancelBtn = buttonsEl.createEl("button", {
      text: "Cancel",
      cls: "claudian-btn claudian-btn--cancel",
    });
    this.cancelBtn.addEventListener("click", () => this.handleCancel());

    this.runBtn = buttonsEl.createEl("button", {
      text: "Run (Ctrl+\u23CE)",
      cls: "claudian-btn claudian-btn--run",
    });
    this.runBtn.addEventListener("click", () => this.handleRun());

    // Divider
    contentEl.createEl("hr", { cls: "claudian-divider" });

    // Output area
    this.outputEl = contentEl.createDiv("claudian-output");

    // Conversation container (chat mode, hidden by default)
    this.conversationEl = this.outputEl.createDiv("claudian-conversation");
    this.conversationEl.style.display = "none";

    // Status line
    this.statusEl = contentEl.createDiv("claudian-status");
    this.statusEl.style.display = "none";

    setTimeout(() => this.promptTextarea.focus(), 50);
  }

  onClose(): void {
    if (this.runner) {
      this.runner.kill();
      this.runner = null;
    }
    const { contentEl } = this;
    contentEl.empty();
  }

  private get activeOutputEl(): HTMLElement {
    return this.mode === "chat" && this.currentTurnClaudeEl
      ? this.currentTurnClaudeEl
      : this.outputEl;
  }

  private handleRun(): void {
    if (this.status === "running") return;

    const prompt = this.promptTextarea.value.trim();
    if (!prompt) return;

    if (this.mode === "chat") {
      this.runChat(prompt);
    } else {
      this.runQuick(prompt);
    }
  }

  private runQuick(prompt: string): void {
    this.hideLoadingIndicator();
    this.outputEl.empty();
    this.conversationEl = this.outputEl.createDiv("claudian-conversation");
    this.conversationEl.style.display = "none";

    this.toolCards.clear();
    this.currentTextBlock = null;
    this.currentTextContent = "";
    this.turns = 0;
    this.costUsd = 0;

    this.setStatus("running");
    this.showLoadingIndicator();

    this.runner = runClaude({
      prompt,
      vaultPath: this.vaultPath,
      currentFilePath: this.currentFilePath,
      settings: this.settings,
      callbacks: {
        onText: (text) => this.handleText(text),
        onToolUse: (event) => this.handleToolUse(event),
        onToolResult: (event) => this.handleToolResult(event),
        onSystemInit: (_sessionId, _tools) => {},
        onDone: (turns, costUsd) => {
          this.turns = turns;
          this.costUsd = costUsd;
          this.hideLoadingIndicator();
          this.promptTextarea.disabled = true;
          this.setStatus("done");
        },
        onError: (message) => {
          this.appendError(message);
          this.hideLoadingIndicator();
          this.promptTextarea.disabled = true;
          this.setStatus("error");
        },
      },
    });
  }

  private runChat(prompt: string): void {
    const resumeSessionId = this.sessionId;
    this.toolCards.clear();
    this.currentTextBlock = null;
    this.currentTextContent = "";
    this.currentTurnMarkdown = "";

    const turnEl = this.conversationEl.createDiv("claudian-turn");
    turnEl.createDiv("claudian-turn__user").textContent = prompt;
    this.currentTurnClaudeEl = turnEl.createDiv("claudian-turn__claude");

    this.promptTextarea.value = "";
    this.setStatus("running");
    this.showLoadingIndicator();
    this.scrollOutputToBottom();

    this.runner = runClaude({
      prompt,
      vaultPath: this.vaultPath,
      currentFilePath: this.currentFilePath,
      settings: this.settings,
      sessionId: resumeSessionId ?? undefined,
      callbacks: {
        onText: (text) => this.handleText(text),
        onToolUse: (event) => this.handleToolUse(event),
        onToolResult: (event) => this.handleToolResult(event),
        onSystemInit: (sessionId, _tools) => {
          this.sessionId = sessionId;
        },
        onDone: (turns, costUsd) => {
          this.turns = turns;
          this.costUsd = costUsd;
          this.hideLoadingIndicator();

          // Persist the completed turn
          this.persistedTurns.push({
            userText: prompt,
            claudeMarkdown: this.currentTurnMarkdown,
          });
          void this.storage.save(this.sessionId, this.persistedTurns);

          this.currentTurnClaudeEl = null;
          this.currentTextBlock = null;
          this.currentTextContent = "";
          this.currentTurnMarkdown = "";
          this.setStatus("done");
          this.promptTextarea.disabled = false;
          this.promptTextarea.focus();
        },
        onError: (message) => {
          this.appendError(message);
          this.hideLoadingIndicator();
          this.currentTurnClaudeEl = null;
          this.currentTextBlock = null;
          this.currentTextContent = "";
          this.currentTurnMarkdown = "";
          this.setStatus("error");
          this.promptTextarea.disabled = false;
        },
      },
    });
  }

  private switchMode(newMode: "quick" | "chat"): void {
    if (newMode === this.mode) return;

    if (this.runner) {
      this.runner.kill();
      this.runner = null;
    }

    this.hideLoadingIndicator();
    this.mode = newMode;
    this.currentTurnClaudeEl = null;
    this.currentTextBlock = null;
    this.currentTextContent = "";
    this.currentTurnMarkdown = "";
    this.toolCards.clear();
    this.promptTextarea.disabled = false;
    this.setStatus("idle");

    if (newMode === "quick") {
      this.quickTabBtn.addClass("claudian-mode-tab--active");
      this.chatTabBtn.removeClass("claudian-mode-tab--active");

      // Reset chat state but keep session/turns in storage
      this.sessionId = null;
      this.persistedTurns = [];

      this.outputEl.empty();
      this.conversationEl = this.outputEl.createDiv("claudian-conversation");
      this.conversationEl.style.display = "none";

      this.clearBtn.style.display = "none";
      this.modalEl.removeClass("claudian-modal--chat");
      this.promptTextarea.setAttribute(
        "placeholder",
        "What should Claude do? (Ctrl+Enter to run)"
      );
    } else {
      this.chatTabBtn.addClass("claudian-mode-tab--active");
      this.quickTabBtn.removeClass("claudian-mode-tab--active");

      this.outputEl.empty();
      this.conversationEl = this.outputEl.createDiv("claudian-conversation");
      this.conversationEl.style.display = "flex";

      this.clearBtn.style.display = "";
      this.modalEl.addClass("claudian-modal--chat");
      this.promptTextarea.setAttribute(
        "placeholder",
        "Message Claude... (Ctrl+Enter to send)"
      );

      void this.restoreConversation();
    }

    this.promptTextarea.focus();
  }

  private async restoreConversation(): Promise<void> {
    const { sessionId, turns } = await this.storage.load();
    this.sessionId = sessionId;
    this.persistedTurns = [...turns];

    for (const turn of turns) {
      const turnEl = this.conversationEl.createDiv("claudian-turn");
      turnEl.createDiv("claudian-turn__user").textContent = turn.userText;
      const claudeEl = turnEl.createDiv("claudian-turn__claude");
      if (turn.claudeMarkdown) {
        await MarkdownRenderer.render(
          this.app,
          turn.claudeMarkdown,
          claudeEl,
          this.currentFilePath ?? "",
          this
        );
      }
    }

    this.scrollOutputToBottom();
  }

  private handleClear(): void {
    if (this.runner) {
      this.runner.kill();
      this.runner = null;
    }

    this.hideLoadingIndicator();
    this.conversationEl.empty();
    this.sessionId = null;
    this.persistedTurns = [];
    this.currentTextBlock = null;
    this.currentTextContent = "";
    this.currentTurnMarkdown = "";
    this.currentTurnClaudeEl = null;
    this.toolCards.clear();
    this.promptTextarea.disabled = false;
    void this.storage.clear();
    this.setStatus("idle");
  }

  private handleCancel(): void {
    if (this.status === "running" && this.runner) {
      this.runner.kill();
      this.runner = null;
      this.hideLoadingIndicator();
      if (this.mode === "chat") {
        this.currentTurnClaudeEl = null;
        this.currentTextBlock = null;
        this.currentTextContent = "";
        this.currentTurnMarkdown = "";
        this.promptTextarea.disabled = false;
      }
      this.setStatus("cancelled");
    } else {
      this.close();
    }
  }

  private handleText(text: string): void {
    if (!this.currentTextBlock) {
      this.currentTextBlock = this.activeOutputEl.createDiv("claudian-text-block");
      this.currentTextContent = "";
    }
    this.currentTextContent += text;
    this.currentTurnMarkdown += text;

    this.currentTextBlock.empty();
    MarkdownRenderer.render(
      this.app,
      this.currentTextContent,
      this.currentTextBlock,
      this.currentFilePath ?? "",
      this
    );
    this.bumpLoadingIndicator();
    this.scrollOutputToBottom();
  }

  private handleToolUse(event: ToolUseEvent): void {
    // Separate text blocks across tool calls with a newline for persisted markdown
    if (this.currentTurnMarkdown && !this.currentTurnMarkdown.endsWith("\n\n")) {
      this.currentTurnMarkdown += "\n\n";
    }
    this.currentTextBlock = null;
    this.currentTextContent = "";

    const cardEl = this.activeOutputEl.createDiv("claudian-tool-card");

    const headerEl = cardEl.createDiv("claudian-tool-card__header");
    const toggleEl = headerEl.createSpan({
      text: "\u25B6",
      cls: "claudian-tool-card__toggle",
    });
    headerEl.createSpan({
      text: event.name,
      cls: "claudian-tool-card__name",
    });

    const inputSummary = this.summarizeToolInput(event.name, event.input);
    headerEl.createSpan({
      text: inputSummary,
      cls: "claudian-tool-card__summary",
    });

    const bodyEl = cardEl.createDiv("claudian-tool-card__body");
    bodyEl.style.display = "none";

    const inputEl = bodyEl.createEl("pre", { cls: "claudian-tool-card__input" });
    inputEl.textContent = JSON.stringify(event.input, null, 2);

    const resultEl = bodyEl.createDiv("claudian-tool-card__result");
    resultEl.textContent = "Waiting for result...";

    const card: ToolCard = {
      toolUse: event,
      cardEl,
      headerEl,
      bodyEl,
      resultEl,
      isExpanded: false,
    };

    this.toolCards.set(event.id, card);

    headerEl.addEventListener("click", () => {
      card.isExpanded = !card.isExpanded;
      bodyEl.style.display = card.isExpanded ? "block" : "none";
      toggleEl.textContent = card.isExpanded ? "\u25BC" : "\u25B6";
    });

    this.bumpLoadingIndicator();
    this.scrollOutputToBottom();
  }

  private handleToolResult(event: ToolResultEvent): void {
    const card = this.toolCards.get(event.tool_use_id);
    if (!card) return;

    card.cardEl.remove();
    this.toolCards.delete(event.tool_use_id);
  }

  private appendError(message: string): void {
    this.currentTextBlock = null;
    this.currentTextContent = "";
    const errorEl = this.activeOutputEl.createDiv("claudian-error-block");
    errorEl.textContent = message;
    this.bumpLoadingIndicator();
    this.scrollOutputToBottom();
  }

  private showLoadingIndicator(): void {
    const container =
      this.mode === "chat" && this.currentTurnClaudeEl
        ? this.currentTurnClaudeEl
        : this.outputEl;
    this.loadingIndicatorEl = container.createDiv("claudian-loading");
    this.loadingIndicatorEl.createSpan({ cls: "claudian-loading__dot" });
    this.loadingIndicatorEl.createSpan({ cls: "claudian-loading__dot" });
    this.loadingIndicatorEl.createSpan({ cls: "claudian-loading__dot" });
    this.scrollOutputToBottom();
  }

  private hideLoadingIndicator(): void {
    if (this.loadingIndicatorEl) {
      this.loadingIndicatorEl.remove();
      this.loadingIndicatorEl = null;
    }
  }

  private bumpLoadingIndicator(): void {
    if (this.loadingIndicatorEl?.parentElement) {
      this.loadingIndicatorEl.parentElement.appendChild(this.loadingIndicatorEl);
    }
  }

  private setStatus(status: ModalStatus): void {
    this.status = status;
    this.statusEl.style.display = "block";
    this.statusEl.className = "claudian-status";

    switch (status) {
      case "running":
        this.statusEl.addClass("claudian-status--running");
        this.statusEl.textContent = "Running...";
        this.runBtn.disabled = true;
        this.cancelBtn.textContent = "Stop";
        break;

      case "done":
        this.statusEl.addClass("claudian-status--done");
        this.statusEl.textContent = "Done";
        this.runBtn.disabled = false;
        this.cancelBtn.textContent = this.mode === "chat" ? "Cancel" : "Close";
        break;

      case "error":
        this.statusEl.addClass("claudian-status--error");
        this.statusEl.textContent = "Error occurred. See output above.";
        this.runBtn.disabled = false;
        this.cancelBtn.textContent = this.mode === "chat" ? "Cancel" : "Close";
        break;

      case "cancelled":
        this.statusEl.addClass("claudian-status--cancelled");
        this.statusEl.textContent = "Cancelled.";
        this.runBtn.disabled = false;
        this.cancelBtn.textContent = this.mode === "chat" ? "Cancel" : "Close";
        break;

      case "idle":
        this.statusEl.style.display = "none";
        this.runBtn.disabled = false;
        this.cancelBtn.textContent = "Cancel";
        break;
    }
  }

  private summarizeToolInput(
    toolName: string,
    input: Record<string, unknown>
  ): string {
    switch (toolName) {
      case "Read":
        return String(input.file_path ?? "");
      case "Edit":
        return String(input.file_path ?? "");
      case "Write":
        return String(input.file_path ?? "");
      case "Glob":
        return String(input.pattern ?? "");
      case "Grep":
        return String(input.pattern ?? "");
      case "LS":
        return String(input.path ?? ".");
      default:
        return Object.keys(input).slice(0, 2).join(", ");
    }
  }

  private scrollOutputToBottom(): void {
    this.outputEl.scrollTop = this.outputEl.scrollHeight;
  }
}
