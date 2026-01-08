# PluginHub

By Jan Sandström

[PixeroJan · GitHub](https://github.com/PixeroJan)

An Obsidian plugin that allows you to browse GitHub, the Official Community Archive, and the Obsidian Forum to find and install plugins across multiple vaults simultaneously.

## Features

- **Official Archive Search:** Access the list of ~1,000 approved community plugins instantly.
- **GitHub Search:** find repositories with keyword matching and author-specific searching (use `@username`).
- **Forum Search:** search the Obsidian Forum for plugin announcements.
- **Plugin Sets:** Save collections of plugins into "Sets" (e.g., "Daily Setup", "Developer Tools") and install the entire group with one click.
- **Multi-Vault Installation:**
  - **All Vaults under parent folder:** Enter a parent folder (like your iCloud Obsidian folder), and it will automatically find all vaults within it.
  - **Selected Vaults:** List specific vault folders.
  - **Toggle Control:** Choose whether to install to your current vault, all vaults or only to the selected vaults.
- **Cross-Platform:** Works on Windows, macOS, and Linux (Desktop) for multi-vault deployment. Browsing works on all platforms.

## Installation

1. Create a folder named `PluginHub` inside your vault's `.obsidian/plugins/` directory.
2. Copy `main.js`, `manifest.json`, and `styles.css` into that folder.
3. Enable the plugin in Obsidian settings.

## Settings Configuration

- **Install location:** Active Vault, All Vaults, Selected Vaults.
- **All Vaults under parent folder:** Set paths to master folders (e.g. `C:\Users\You\iCloudDrive\iCloud~md~obsidian`). It will scan every subfolder containing a `.obsidian` folder. One path per line if many. I.e. One folder on your Mac/PC and one on Icloud.
- **Selected Vaults:** List specific vaults.
- **Manage Sets:** Create, name, and manage your custom plugin sets.

## Development

1. Install dependencies: `npm install`
2. Build the plugin: `npm run build`



Settings Panel.

![1_Settings.png](https://github.com/PixeroJan/PluginHub/blob/main/1_Settings.png)

Search Official Obsidian Plugin archive.

![2_Search_official.jpg](https://github.com/PixeroJan/PluginHub/blob/main/2_Search_official.jpg)

Search on Github.

![3_Search_github.jpg](https://github.com/PixeroJan/PluginHub/blob/main/3_Search_github.jpg)

Search the Obsidian Forum.

![4_Search_forum.jpg](https://github.com/PixeroJan/PluginHub/blob/main/4_Search_forum.jpg)
