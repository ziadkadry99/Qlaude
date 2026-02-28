import { Plugin, TFile } from "obsidian";
import { ClaudianSettings, DEFAULT_SETTINGS, ClaudianSettingTab } from "./src/settings";
import { ClaudianModal, ChatStorage, ChatTurnData } from "./src/modal";

interface StoredData extends Record<string, unknown> {
  _chat?: { sessionId: string | null; turns: ChatTurnData[] };
}

export default class ClaudianPlugin extends Plugin {
  settings!: ClaudianSettings;

  async onload(): Promise<void> {
    await this.loadSettings();

    if (this.settings.clearChatOnStart) {
      const data: StoredData = (await this.loadData() as StoredData | null) ?? {};
      delete data._chat;
      await this.saveData(data);
    }

    this.addSettingTab(new ClaudianSettingTab(this.app, this));

    this.addCommand({
      id: "open-claudian-modal",
      name: "Open",
      callback: () => this.openModal(),
    });

    this.addRibbonIcon("bot", "Open", () => this.openModal());
  }

  async loadSettings(): Promise<void> {
    const data = (await this.loadData() as StoredData | null) ?? {};
    this.settings = Object.assign({}, DEFAULT_SETTINGS, data);
    // Ensure nested permissions object is fully merged
    this.settings.permissions = Object.assign(
      {},
      DEFAULT_SETTINGS.permissions,
      this.settings.permissions
    );
  }

  async saveSettings(): Promise<void> {
    // Merge with existing data so chat persistence (stored under _chat) is preserved
    const existing = (await this.loadData() as StoredData | null) ?? {};
    await this.saveData({ ...existing, ...this.settings });
  }

  openModal(): void {
    const vaultPath = this.getVaultPath();
    if (!vaultPath) {
      console.error("Claudian: Could not determine vault path");
      return;
    }

    const activeFile = this.app.workspace.getActiveFile();
    const currentFilePath: string | null = activeFile instanceof TFile
      ? activeFile.path
      : null;

    const storage: ChatStorage = {
      load: async () => {
        const data: StoredData = (await this.loadData() as StoredData | null) ?? {};
        return data._chat ?? { sessionId: null, turns: [] };
      },
      save: async (sessionId, turns) => {
        const data: StoredData = (await this.loadData() as StoredData | null) ?? {};
        data._chat = { sessionId, turns };
        await this.saveData(data);
      },
      clear: async () => {
        const data: StoredData = (await this.loadData() as StoredData | null) ?? {};
        delete data._chat;
        await this.saveData(data);
      },
    };

    new ClaudianModal(
      this.app,
      this.settings,
      vaultPath,
      currentFilePath,
      storage
    ).open();
  }

  private getVaultPath(): string | null {
    const adapter = this.app.vault.adapter as { getBasePath?: () => string };
    if (typeof adapter.getBasePath === "function") {
      return adapter.getBasePath();
    }
    return null;
  }
}
