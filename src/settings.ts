import { App, PluginSettingTab, Setting } from "obsidian";
import type ClaudianPlugin from "../main";

export interface ClaudianPermissions {
  readVault: boolean;
  listVaultStructure: boolean;
  editCurrentFile: boolean;
  editAnyFile: boolean;
  createFiles: boolean;
}

export interface ClaudianSettings {
  claudeBinaryPath: string;
  model: string;
  clearChatOnStart: boolean;
  permissions: ClaudianPermissions;
}

export const DEFAULT_SETTINGS: ClaudianSettings = {
  claudeBinaryPath: "claude",
  model: "claude-haiku-4-5",
  clearChatOnStart: false,
  permissions: {
    readVault: false,
    listVaultStructure: false,
    editCurrentFile: false,
    editAnyFile: false,
    createFiles: false,
  },
};

export function buildToolsList(settings: ClaudianSettings): string[] {
  const tools: string[] = ["Read"];

  if (settings.permissions.listVaultStructure) {
    tools.push("Glob", "Grep", "LS");
  }

  if (settings.permissions.editCurrentFile || settings.permissions.editAnyFile) {
    tools.push("Edit");
  }

  if (settings.permissions.editAnyFile || settings.permissions.createFiles) {
    tools.push("Write");
  }

  return tools;
}

export function buildPermissionInstructions(
  settings: ClaudianSettings,
  currentFilePath: string | null
): string {
  const lines: string[] = [];

  lines.push("## Permissions");
  lines.push("");
  lines.push("You have the following permissions in this vault:");
  lines.push("");

  if (settings.permissions.readVault) {
    lines.push(`- Read files: YES (any file in the vault)`);
  } else if (currentFilePath) {
    lines.push(
      `- Read files: RESTRICTED — you may only read the currently active file: ${currentFilePath}`
    );
  } else {
    lines.push(`- Read files: RESTRICTED — no file is currently active, you may not read any files`);
  }

  if (settings.permissions.listVaultStructure) {
    lines.push(`- List vault structure (Glob, Grep, LS): YES`);
  } else {
    lines.push(`- List vault structure (Glob, Grep, LS): NO`);
  }

  if (settings.permissions.editAnyFile) {
    lines.push(`- Edit any file: YES`);
  } else if (settings.permissions.editCurrentFile) {
    if (currentFilePath) {
      lines.push(
        `- Edit files: RESTRICTED — you may only edit the currently active file: ${currentFilePath}`
      );
    } else {
      lines.push(`- Edit files: RESTRICTED — no file is currently active`);
    }
  } else {
    lines.push(`- Edit files: NO`);
  }

  if (settings.permissions.createFiles) {
    lines.push(`- Create new files: YES`);
  } else {
    lines.push(`- Create new files: NO`);
  }

  lines.push("");
  lines.push(
    "Strictly respect these permissions. Do not attempt actions outside what is permitted above."
  );

  return lines.join("\n");
}

export class ClaudianSettingTab extends PluginSettingTab {
  plugin: ClaudianPlugin;

  constructor(app: App, plugin: ClaudianPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("Claude binary path")
      .setDesc(
        "Full path to the Claude CLI binary, or just `claude` if it is on your PATH."
      )
      .addText((text) =>
        text
          .setValue(this.plugin.settings.claudeBinaryPath)
          .onChange(async (value) => {
            this.plugin.settings.claudeBinaryPath = value.trim() || "claude";
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Model")
      .setDesc(
        "Claude model ID to use for all requests. Any model supported by the CLI can be entered here."
      )
      .addText((text) =>
        text
          .setValue(this.plugin.settings.model)
          .onChange(async (value) => {
            this.plugin.settings.model = value.trim() || "claude-haiku-4-5";
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Clear chat on start")
      .setDesc("Automatically clear the chat history and session when Obsidian starts.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.clearChatOnStart)
          .onChange(async (value) => {
            this.plugin.settings.clearChatOnStart = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl).setName("Permissions").setHeading();

    containerEl.createEl("p", {
      text: "Control what Claude is allowed to do in your vault.",
      cls: "setting-item-description",
    });

    new Setting(containerEl)
      .setName("Read entire vault")
      .setDesc("Read any file in the vault, not just the currently active file.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.permissions.readVault)
          .onChange(async (value) => {
            this.plugin.settings.permissions.readVault = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("List vault structure")
      .setDesc("Search and list files in your vault using glob, grep, and ls.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.permissions.listVaultStructure)
          .onChange(async (value) => {
            this.plugin.settings.permissions.listVaultStructure = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Edit current file")
      .setDesc("Edit the currently active file.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.permissions.editCurrentFile)
          .onChange(async (value) => {
            this.plugin.settings.permissions.editCurrentFile = value;
            if (!value) {
              this.plugin.settings.permissions.editAnyFile = false;
              await this.plugin.saveSettings();
              this.display();
            } else {
              await this.plugin.saveSettings();
            }
          })
      );

    new Setting(containerEl)
      .setName("Edit any file")
      .setDesc(
        "Edit any file in the vault (also enables edit current file)."
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.permissions.editAnyFile)
          .onChange(async (value) => {
            this.plugin.settings.permissions.editAnyFile = value;
            if (value) {
              this.plugin.settings.permissions.editCurrentFile = true;
            }
            await this.plugin.saveSettings();
            this.display();
          })
      );

    new Setting(containerEl)
      .setName("Create files")
      .setDesc("Create new files in the vault.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.permissions.createFiles)
          .onChange(async (value) => {
            this.plugin.settings.permissions.createFiles = value;
            await this.plugin.saveSettings();
          })
      );
  }

}
