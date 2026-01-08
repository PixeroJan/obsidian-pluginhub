import { App, Plugin, PluginSettingTab, Setting, WorkspaceLeaf, ItemView, requestUrl, Menu, Notice, TextAreaComponent } from 'obsidian';

interface PluginSet {
	name: string;
	plugins: string[]; // array of full_name
}

interface PluginSettings {
	extraVaultPaths: string[];
	parentVaultDirectories: string[];
	pluginSets: PluginSet[];
	installLocation: 'active' | 'all' | 'selected';
}

const DEFAULT_SETTINGS: PluginSettings = {
	extraVaultPaths: [],
	parentVaultDirectories: [],
	pluginSets: [],
	installLocation: 'all'
}

export const VIEW_TYPE_BROWSER = "plugin-hub-view";

interface GithubRepo {
	full_name: string;
	description: string;
	stargazers_count: number;
	html_url: string;
	isDesktopOnly?: boolean;
	author?: string;
	owner: { login: string; avatar_url: string };
}

interface GithubUser {
	login: string;
	avatar_url: string;
	html_url: string;
	type: string;
}

const DESKTOP_ONLY_CACHE: Record<string, boolean> = {};

interface ForumResult {
	title: string;
	slug: string;
	id: number;
	posts_count?: number;
	like_count?: number;
	views?: number;
	tags?: string[];
}

class ForumService {
	static async search(query: string): Promise<ForumResult[]> {
		let q = query.trim();
		// User requested to stick to "Share & Showcase" (Category 9).
		// We REMOVED the API-level "-#theme" exclusions because they were causing valid plugin results 
		// (like "ToWord") to entirely disappear from the API response.
		// We will filter themes/css client-side instead.
		const searchQuery = q 
			? `${q} category:9` 
			: `category:9`;
		
		const url = `https://forum.obsidian.md/search.json?q=${encodeURIComponent(searchQuery)}`;
		
		try {
			const response = await requestUrl({ url });
			const data = response.json;
			const topics = data.topics || [];
			const posts = data.posts || []; 

			const postTopics = posts.map((p: any) => ({
				title: p.topic_title,
				slug: p.topic_slug,
				id: p.topic_id,
				posts_count: 0, 
				like_count: p.like_count,
				views: 0,
				// Posts don't carry tags in search results usually, but that's okay, 
				// we'll fall back to title filtering for them.
				tags: [] 
			}));

			const allItems = [...topics, ...postTopics];
			const seenIds = new Set<number>();
			const uniqueItems: ForumResult[] = [];

			for (const item of allItems) {
				if (!seenIds.has(item.id)) {
					seenIds.add(item.id);
					uniqueItems.push({
						title: item.title,
						slug: item.slug,
						id: item.id,
						posts_count: item.posts_count,
						like_count: item.like_count,
						views: item.views,
						tags: item.tags || []
					});
				}
			}

			return uniqueItems;
		} catch (e) {
			console.error("Forum search failed", e);
			return [];
		}
	}
}

class CommunityArchiveService {
	static async search(query: string): Promise<GithubRepo[]> {
		const url = "https://raw.githubusercontent.com/obsidianmd/obsidian-releases/master/community-plugins.json";
		const response = await requestUrl({ url });
		const plugins = response.json;
		const searchLower = query.toLowerCase().trim();
		
		// Handle simple singular/plural for "plugin"
		const isPluginSearch = searchLower === "plugin" || searchLower === "plugins";
		
		// Create a singular version if it ends in 's' to be more inclusive
		const searchSingular = (searchLower.length > 3 && searchLower.endsWith('s')) ? searchLower.slice(0, -1) : searchLower;
		
		return plugins
			.filter((p: any) => {
				if (!searchLower) return true;
				
				// If searching for "plugin" or "plugins", we want everything (as they are all plugins)
				if (isPluginSearch) return true;

				const name = p.name.toLowerCase();
				const author = p.author.toLowerCase();
				const description = p.description.toLowerCase();
				const id = p.id.toLowerCase();

				return name.includes(searchLower) || name.includes(searchSingular) ||
					   author.includes(searchLower) ||
					   description.includes(searchLower) || description.includes(searchSingular) || 
					   id.includes(searchLower);
			})
			.map((p: any) => ({
				full_name: p.repo,
				description: p.description,
				stargazers_count: 0, // Not available in this list
				html_url: `https://github.com/${p.repo}`,
				owner: { 
					login: p.repo.split('/')[0], 
					avatar_url: "" 
				}
				// isDesktopOnly will be checked by the renderer from manifest.json
			}));
	}
}

class GithubService {
	static async searchUsers(query: string): Promise<GithubUser[]> {
		const url = `https://api.github.com/search/users?q=${encodeURIComponent(query)}&per_page=10`;
		try {
			const response = await requestUrl({
				url: url,
				method: 'GET',
				headers: {
					'Accept': 'application/vnd.github.v3+json'
				}
			});
			return response.json.items || [];
		} catch (e) {
			console.error("User search failed", e);
			return [];
		}
	}

	static async searchPlugins(query: string, sort: string = "stars"): Promise<GithubRepo[]> {
		const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(query)}&sort=${sort}&order=desc`;
		try {
			const response = await requestUrl({
				url: url,
				method: 'GET',
				headers: {
					'Accept': 'application/vnd.github.v3+json'
				}
			});
			return response.json.items || [];
		} catch (error: any) {
			if (error.status === 403) {
				throw new Error("Request failed, status 403 (Rate Limit Exceeded)");
			}
			throw error;
		}
	}

	static async getLatestRelease(fullName: string) {
		const url = `https://api.github.com/repos/${fullName}/releases/latest`;
		const response = await requestUrl({
			url: url,
			method: 'GET',
		});
		return response.json;
	}
}

export default class PluginHub extends Plugin {
	settings: PluginSettings = DEFAULT_SETTINGS;

	async onload() {
		await this.loadSettings();

		this.addRibbonIcon('search', 'Browse Plugins', () => {
			this.activateView();
		});

		this.addSettingTab(new PluginHubSettingTab(this.app, this));

		this.registerView(
			VIEW_TYPE_BROWSER,
			(leaf) => new PluginBrowserView(leaf, this)
		);
	}

	onunload() {
		this.app.workspace.detachLeavesOfType(VIEW_TYPE_BROWSER);
	}

	async activateView() {
		const { workspace } = this.app;

		let leaf: WorkspaceLeaf | null = null;
		const leaves = workspace.getLeavesOfType(VIEW_TYPE_BROWSER);

		if (leaves.length > 0) {
			leaf = leaves[0];
		} else {
			leaf = workspace.getLeaf('tab');
			await leaf.setViewState({
				type: VIEW_TYPE_BROWSER,
				active: true,
			});
		}

		workspace.revealLeaf(leaf);
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	async installPluginFromGithub(fullName: string) {
		const release = await GithubService.getLatestRelease(fullName);
		const assets = release.assets;
		
		const mainJs = assets.find((a: any) => a.name === 'main.js');
		const manifestJson = assets.find((a: any) => a.name === 'manifest.json');
		const stylesCss = assets.find((a: any) => a.name === 'styles.css');

		if (!mainJs || !manifestJson) {
			throw new Error("Plugin does not have required release assets (main.js and manifest.json).");
		}

		const manifestResp = await requestUrl({ url: manifestJson.browser_download_url });
		const manifest = manifestResp.json;
		const pluginId = manifest.id;

		const pluginDir = `${this.app.vault.configDir}/plugins/${pluginId}`;
		
		// Create dir and download files
		const mainJsResp = await requestUrl({ url: mainJs.browser_download_url });
		const manifestContent = JSON.stringify(manifest, null, 2);
		let stylesContent = "";
		if (stylesCss) {
			const stylesResp = await requestUrl({ url: stylesCss.browser_download_url });
			stylesContent = stylesResp.text;
		}

		// Determine which vaults to install to
		const installToActive = this.settings.installLocation === 'active' || this.settings.installLocation === 'all';
		const useParentDirs = this.settings.installLocation === 'all';
		const useSelectedVaults = this.settings.installLocation === 'all' || this.settings.installLocation === 'selected';

		if (installToActive) {
			await this.app.vault.adapter.mkdir(pluginDir);
			await this.app.vault.adapter.write(`${pluginDir}/main.js`, mainJsResp.text);
			await this.app.vault.adapter.write(`${pluginDir}/manifest.json`, manifestContent);
			if (stylesCss) {
				await this.app.vault.adapter.write(`${pluginDir}/styles.css`, stylesContent);
			}
		}

		let targetVaultsCount = 0;

		// Multi-Vault Deployment Logic (Cross-platform)
		// Note: We use require('fs') only if it exists (Desktop)
		if (useParentDirs || useSelectedVaults) {
			try {
				const fs = require('fs');
				const path = require('path');
				
				const targetVaults: string[] = [];

				if (useSelectedVaults) {
					targetVaults.push(...this.settings.extraVaultPaths);
				}

				if (useParentDirs) {
					for (const parentPath of this.settings.parentVaultDirectories) {
						if (fs.existsSync(parentPath)) {
							const subfolders = fs.readdirSync(parentPath);
							for (const sub of subfolders) {
								const fullPath = path.join(parentPath, sub);
								const obsidianFolder = path.join(fullPath, '.obsidian');
								if (fs.statSync(fullPath).isDirectory() && fs.existsSync(obsidianFolder)) {
									if (!targetVaults.includes(fullPath)) {
										targetVaults.push(fullPath);
									}
								}
							}
						}
					}
				}

				for (const vaultPath of targetVaults) {
					const targetDir = path.join(vaultPath, '.obsidian', 'plugins', pluginId);
					if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
					
					fs.writeFileSync(path.join(targetDir, 'main.js'), mainJsResp.text);
					fs.writeFileSync(path.join(targetDir, 'manifest.json'), manifestContent);
					if (stylesCss) {
						fs.writeFileSync(path.join(targetDir, 'styles.css'), stylesContent);
					}
				}
				targetVaultsCount = targetVaults.length;
			} catch (e: any) {
				console.error("Failed to copy to extra vaults:", e);
			}
		}

		// Reload plugins
		await (this.app as any).plugins.loadManifests();
		new Notice(`Installed ${fullName}${installToActive ? ' to active vault' : ''}${targetVaultsCount > 0 ? ` and ${targetVaultsCount} extra vaults` : ''}.`);
	}
}

class PluginBrowserView extends ItemView {
	plugin: PluginHub;

	constructor(leaf: WorkspaceLeaf, plugin: PluginHub) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType() {
		return VIEW_TYPE_BROWSER;
	}

	getDisplayText() {
		return "Plugin Browser";
	}

	async onOpen() {
		const container = this.containerEl.children[1] as HTMLElement;
		container.empty();
		container.createEl("h4", { text: "Search Obsidian Plugins" });
		
		const searchContainer = container.createDiv({ cls: "search-container" });
		const input = searchContainer.createEl("input", { type: "text", placeholder: "Plugin name, keyword, or @author..." });
		input.style.width = "100%";
		input.style.marginBottom = "10px";

		const btnRow = searchContainer.createDiv();
		btnRow.style.display = "flex";
		btnRow.style.flexWrap = "wrap";
		btnRow.style.gap = "8px";
		btnRow.style.marginBottom = "20px";

		const archiveBtn = btnRow.createEl("button", { text: "Official Archive", cls: "mod-cta" });
		const githubBtn = btnRow.createEl("button", { text: "Search GitHub" });
		const forumBtn = btnRow.createEl("button", { text: "Search Forum" });
		
		const results = container.createDiv({ cls: "results-container" });

		const renderRepos = (repos: GithubRepo[]) => {
			results.empty();
			
			const searchVal = input.value.toLowerCase();
			const isAuthorSearch = searchVal.startsWith("@");
			const authorQuery = isAuthorSearch ? searchVal.slice(1) : "";

			// Filter and Sort
			let filteredRepos = repos.filter(repo => {
				const lowerName = repo.full_name.toLowerCase();
				const lowerDesc = (repo.description || "").toLowerCase();
				const owner = repo.owner.login.toLowerCase();
				
				// Exclude "vault" repositories which are usually personal configurations, 
				// unless the search specifically includes the word "vault"
				const isVault = lowerName.includes("/obsidian-vault") || 
				                lowerName.endsWith("/vault") || 
								lowerName.includes("-vault") ||
								lowerDesc.includes("my obsidian vault") ||
								lowerDesc.includes("personal vault") ||
								lowerDesc.includes("personal notes") ||
								lowerDesc.includes("my notes") ||
								lowerDesc.includes("sharing my vault");

				if (!searchVal.includes("vault") && isVault) {
					return false;
				}

				if (isAuthorSearch || searchVal.includes("theme") || searchVal.includes("css")) return true;
				
				const isTheme = lowerName.includes("-theme") || lowerName.endsWith("/theme") || 
								lowerName.includes("obsidian-theme") || 
								lowerDesc.includes("theme for obsidian") || 
								lowerDesc.includes("style for obsidian");
				const isCss = lowerName.includes("css") || lowerDesc.includes("css snippet") || 
							  lowerDesc.includes("custom css") || lowerDesc.includes("visual style");
				
				return !isTheme && !isCss;
			});

			// For author searches, prioritize results where the owner's name matches or starts with the query
			if (isAuthorSearch) {
				filteredRepos.sort((a, b) => {
					const aOwner = a.owner.login.toLowerCase();
					const bOwner = b.owner.login.toLowerCase();
					const aStarts = aOwner.startsWith(authorQuery) ? 1 : 0;
					const bStarts = bOwner.startsWith(authorQuery) ? 1 : 0;
					
					if (aStarts !== bStarts) return bStarts - aStarts;
					return b.stargazers_count - a.stargazers_count;
				});
			}

			if (filteredRepos.length === 0) {
				results.createEl("p", { text: "No plugins found." });
				return;
			}
			filteredRepos.forEach(repo => {
				const item = results.createDiv({ cls: "plugin-result-item" });

				const titleLine = item.createDiv();
				titleLine.createEl("strong", { text: repo.full_name });
				if (repo.stargazers_count > 0) {
					titleLine.createEl("span", { text: ` (⭐ ${repo.stargazers_count})`, cls: "stars" });
				}
				
				const descPara = item.createEl("p", { cls: "description" });
				const descSpan = descPara.createEl("span", { text: repo.description || "No description" });
				
				const createBadge = () => {
					descPara.createEl("span", { text: "Desktop Only", cls: "desktop-only-badge" });
				};

				if (repo.isDesktopOnly) {
					createBadge();
				} else if (repo.isDesktopOnly === undefined) {
					// Async check
					const repoName = repo.full_name;
					if (DESKTOP_ONLY_CACHE[repoName] !== undefined) {
						if (DESKTOP_ONLY_CACHE[repoName]) createBadge();
					} else {
						// Attempt to fetch manifest.json
						const checkManifest = async () => {
							try {
								const manifestUrl = `https://raw.githubusercontent.com/${repoName}/HEAD/manifest.json`;
								const resp = await requestUrl({ url: manifestUrl });
								if (resp.status === 200) {
									const manifest = resp.json;
									DESKTOP_ONLY_CACHE[repoName] = manifest.isDesktopOnly === true || manifest.desktopOnly === true;
									if (DESKTOP_ONLY_CACHE[repoName]) {
										createBadge();
									}
								} else {
									DESKTOP_ONLY_CACHE[repoName] = false;
								}
							} catch (e) {
								DESKTOP_ONLY_CACHE[repoName] = false;
							}
						};
						checkManifest();
					}
				}
				
				const actions = item.createDiv({ cls: "actions-row" });
				
				const viewBtn = actions.createEl("button", { text: "Read More" });
				viewBtn.addEventListener("click", () => {
					window.open(repo.html_url, '_blank');
				});

				const installBtn = actions.createEl("button", { text: "Install", cls: "mod-cta" });
				
				installBtn.addEventListener("click", async () => {
					installBtn.disabled = true;
					installBtn.innerText = "Installing...";
					try {
						await this.plugin.installPluginFromGithub(repo.full_name);
						installBtn.innerText = "Installed!";
					} catch (e: any) {
						installBtn.innerText = "Failed: " + e.message;
						installBtn.disabled = false;
					}
				});

				const plugin = this.plugin;
				if (plugin.settings.pluginSets.length > 0) {
					const addToSetBtn = actions.createEl("button", { text: "Add to Set..." });
					addToSetBtn.addEventListener("click", (event: MouseEvent) => {
						const menu = new Menu();
						plugin.settings.pluginSets.forEach((set: PluginSet) => {
							menu.addItem((item) => {
								item.setTitle(`Add to "${set.name}"`)
									.setIcon("plus-circle")
									.onClick(async () => {
										if (!set.plugins.includes(repo.full_name)) {
											set.plugins.push(repo.full_name);
											await plugin.saveSettings();
											new Notice(`Added ${repo.full_name} to set "${set.name}"`);
										} else {
											new Notice(`${repo.full_name} is already in this set.`);
										}
									});
							});
						});
						menu.showAtMouseEvent(event);
					});
				}
			});
		};

		const renderUsers = (users: GithubUser[]) => {
			results.empty();
			if (users.length === 0) {
				results.createEl("p", { text: "No users found." });
				return;
			}
			
			results.createEl("h4", { text: "Select a user to browse their plugins:" });
			
			const grid = results.createDiv({ cls: "user-grid" });
			grid.style.display = "grid";
			grid.style.gridTemplateColumns = "repeat(auto-fill, minmax(120px, 1fr))";
			grid.style.gap = "10px";

			users.forEach(user => {
				const card = grid.createDiv({ cls: "user-card" });
				card.style.border = "1px solid var(--background-modifier-border)";
				card.style.padding = "10px";
				card.style.borderRadius = "4px";
				card.style.textAlign = "center";
				card.style.cursor = "pointer";
				card.style.backgroundColor = "var(--background-secondary)";
				card.onmouseover = () => { card.style.backgroundColor = "var(--background-primary)"; };
				card.onmouseout = () => { card.style.backgroundColor = "var(--background-secondary)"; };

				const img = card.createEl("img");
				img.src = user.avatar_url;
				img.style.width = "50px";
				img.style.height = "50px";
				img.style.borderRadius = "50%";
				img.style.marginBottom = "5px";

				card.createEl("div", { text: user.login, style: "font-weight: bold; overflow: hidden; text-overflow: ellipsis;" });
				
				card.addEventListener("click", async () => {
					// Directly trigger plugin search for this user
					const query = `user:${user.login} obsidian NOT vault NOT configuration`;
					results.empty();
					results.createEl("p", { text: `Searching plugins by ${user.login}...` });
					
					// Update display
					input.value = `@${user.login}`; 
					
					try {
						const plugins = await GithubService.searchPlugins(query, "updated");
						renderRepos(plugins);
					} catch(e: any) {
						results.createEl("p", { text: "Error: " + e.message });
					}
				});
			});
		};

		archiveBtn.addEventListener("click", async () => {
			results.empty();
			results.createEl("p", { text: "Searching official community archive..." });
			try {
				const repos = await CommunityArchiveService.search(input.value);
				renderRepos(repos);
			} catch (e: any) {
				results.createEl("p", { text: "Error searching archive: " + e.message });
			}
		});
		
		githubBtn.addEventListener("click", async () => {
			results.empty();
			
			try {
				let rawQuery = input.value.trim();
				
				if (rawQuery.startsWith("@")) {
					results.createEl("p", { text: `Searching users matching "${rawQuery}"...` });
					const name = rawQuery.slice(1);
					// Search for users directly
					const users = await GithubService.searchUsers(name);
					renderUsers(users);
				} else {
					results.createEl("p", { text: `Searching GitHub for: ${input.value}...` });
					// Standard refined search for general keywords
					// We removed the strict "plugin" keyword to ensure we find repos that don't explicitly say "plugin" in the description
					const refinedQuery = `${rawQuery} obsidian NOT theme NOT css NOT vault NOT configuration -topic:theme -topic:obsidian-theme`;
					const repos = await GithubService.searchPlugins(refinedQuery, "stars");
					renderRepos(repos);
				}
			} catch (e: any) {
				console.error(e);
				results.empty();
				if (e.message && e.message.includes("403")) {
					results.createEl("p", { text: "⚠️ GitHub API Rate Limit Exceeded.", style: "color: var(--text-error);" });
					results.createEl("p", { text: "Please wait a moment before searching again." });
				} else {
					results.createEl("p", { text: "Error searching: " + e.message });
				}
			}
		});

		forumBtn.addEventListener("click", async () => {
			results.empty();
			results.createEl("p", { text: `Searching forum for: ${input.value}...` });
			try {
				const topics = await ForumService.search(input.value);
				results.empty();
				if (topics.length === 0) {
					results.createEl("p", { text: "No forum topics found." });
					return;
				}
				topics.forEach(topic => {
					// Final programmatic filter for forum topics
					const lowerTitle = topic.title.toLowerCase();
					const searchVal = input.value.toLowerCase();
					const topicTags = topic.tags || [];
					
					// Only exclude themes/snippets if the user didn't ask for them
					if (!searchVal.includes("theme") && !searchVal.includes("css") && !searchVal.includes("snippet")) {
						// Check tags (if available)
						if (topicTags.includes("theme") || topicTags.includes("css")) return;

						// Check title content
						const isTheme = lowerTitle.includes("theme") && !lowerTitle.includes("plugin"); 
						const isSnippet = lowerTitle.includes("css snippet") || lowerTitle.includes("snippet");
						
						if (isTheme || isSnippet) return;
					}

					const item = results.createDiv({ cls: "forum-result-item" });
					item.createEl("strong", { text: topic.title });
					
					const stats = item.createDiv({ cls: "topic-stats" });
					
					const statsParts = [];
					if (topic.like_count) statsParts.push(`❤️ ${topic.like_count}`);
					if (topic.views) statsParts.push(`👁️ ${topic.views}`);
					if (topic.posts_count) statsParts.push(`💬 ${topic.posts_count}`);
					stats.setText(statsParts.join("  •  "));

					const actions = item.createDiv({ cls: "actions-row" });
					actions.createEl("button", { text: "View on Forum" }).addEventListener("click", () => {
						window.open(`https://forum.obsidian.md/t/${topic.slug}/${topic.id}`, '_blank');
					});
				});
			} catch (e: any) {
				results.createEl("p", { text: "Error searching forum: " + e.message });
			}
		});
	}
}

class PluginHubSettingTab extends PluginSettingTab {
	plugin: PluginHub;

	constructor(app: App, plugin: PluginHub) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		containerEl.createEl("h2", { text: "Installation Settings" });

		new Setting(containerEl)
			.setName('Install Location')
			.setDesc('Choose where plugins should be installed by default.')
			.addDropdown(dropdown => dropdown
				.addOption('active', 'Active Vault')
				.addOption('all', 'All Vaults')
				.addOption('selected', 'Selected Vaults')
				.setValue(this.plugin.settings.installLocation)
				.onChange(async (value) => {
					this.plugin.settings.installLocation = value as 'active' | 'all' | 'selected';
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('All Vaults under parent folder')
			.setDesc('Add absolute paths to folders containing multiple vaults. One path per line.')
			.addTextArea((text: TextAreaComponent) => {
				text.setPlaceholder('e.g. /Users/name/Documents/Obsidian/ or C:\\Vaults\\Obsidian\\')
					.setValue(this.plugin.settings.parentVaultDirectories.join('\n'))
					.onChange(async (value: string) => {
						this.plugin.settings.parentVaultDirectories = value.split('\n').filter((p: string) => p.trim() !== '');
						await this.plugin.saveSettings();
					});
				text.inputEl.rows = 10;
				// Make the textarea significantly larger as requested
				text.inputEl.style.width = "350px";
				text.inputEl.style.maxWidth = "100%";
				text.inputEl.style.height = "200px";
			});

		new Setting(containerEl)
			.setName('Selected Vaults')
			.setDesc('Add absolute paths to other individual vaults. One path per line.')
			.addTextArea((text: TextAreaComponent) => {
				text.setPlaceholder('e.g. /Users/name/Vault or C:\\Vaults\\Vault')
					.setValue(this.plugin.settings.extraVaultPaths.join('\n'))
					.onChange(async (value: string) => {
						this.plugin.settings.extraVaultPaths = value.split('\n').filter((p: string) => p.trim() !== '');
						await this.plugin.saveSettings();
					});
				text.inputEl.rows = 10;
				// Make the textarea significantly larger as requested
				text.inputEl.style.width = "350px";
				text.inputEl.style.maxWidth = "100%";
				text.inputEl.style.height = "200px";
			});

		containerEl.createEl("h2", { text: "Manage Plugin Sets" });
		
		const setsContainer = containerEl.createDiv();
		this.renderSets(setsContainer);

		new Setting(containerEl)
			.setName("Create New Set")
			.addButton(btn => btn
				.setButtonText("Add Set")
				.setCta()
				.onClick(async () => {
					this.plugin.settings.pluginSets.push({ name: "New Set", plugins: [] });
					await this.plugin.saveSettings();
					this.display();
				}));
	}

	renderSets(container: HTMLElement) {
		this.plugin.settings.pluginSets.forEach((set, index) => {
			const setEl = container.createDiv();
			setEl.style.border = "1px solid var(--background-modifier-border)";
			setEl.style.padding = "15px";
			setEl.style.marginBottom = "20px";
			setEl.style.borderRadius = "8px";
			
			const header = setEl.createDiv();
			header.style.display = "flex";
			header.style.gap = "10px";
			header.style.alignItems = "center";
			header.style.marginBottom = "10px";

			const nameInput = header.createEl("input", { type: "text", value: set.name });
			nameInput.style.flexGrow = "1";
			nameInput.addEventListener("change", async () => {
				set.name = nameInput.value;
				await this.plugin.saveSettings();
			});

			const delBtn = header.createEl("button", { text: "Delete Set" });
			delBtn.style.backgroundColor = "var(--text-error)";
			delBtn.style.color = "white";
			delBtn.addEventListener("click", async () => {
				this.plugin.settings.pluginSets.splice(index, 1);
				await this.plugin.saveSettings();
				this.display();
			});

			const pluginList = setEl.createDiv();
			pluginList.style.fontSize = "0.9em";
			pluginList.style.color = "var(--text-muted)";
			pluginList.style.marginBottom = "10px";

			if (set.plugins.length === 0) {
				pluginList.setText("No plugins in this set yet. Add them from the Browser.");
			} else {
				set.plugins.forEach((pName, pIndex) => {
					const pRow = pluginList.createDiv();
					pRow.style.display = "flex";
					pRow.style.justifyContent = "space-between";
					pRow.style.alignItems = "center";
					pRow.style.marginBottom = "5px";

					pRow.createEl("span", { text: pName });
					const removeBtn = pRow.createEl("button", { text: "Remove", cls: "mod-warning" });
					removeBtn.className = "clickable-icon";
					removeBtn.style.padding = "2px 5px";
					removeBtn.addEventListener("click", async () => {
						set.plugins.splice(pIndex, 1);
						await this.plugin.saveSettings();
						this.display();
					});
				});
			}

			const btnContainer = setEl.createDiv();
			btnContainer.style.display = "flex";
			btnContainer.style.justifyContent = "flex-end";
			btnContainer.style.marginTop = "10px";

			const installSetBtn = btnContainer.createEl("button", { text: `Install set: ${set.name}`, cls: "mod-cta" });
			installSetBtn.style.padding = "4px 12px";
			installSetBtn.style.fontSize = "0.85em";
			installSetBtn.addEventListener("click", async () => {
				installSetBtn.disabled = true;
				installSetBtn.innerText = "Installing...";
				for (const fullName of set.plugins) {
					try {
						await this.plugin.installPluginFromGithub(fullName);
					} catch (e: any) {
						console.error(`Failed to install ${fullName}:`, e);
					}
				}
				installSetBtn.innerText = "Done!";
				setTimeout(() => {
					installSetBtn.disabled = false;
					installSetBtn.innerText = `Install set: ${set.name}`;
				}, 3000);
			});
		});
	}
}
