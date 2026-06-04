const { App, Modal, Notice, Plugin, TFile } = require("obsidian");

const REQUIRED_FIELDS = ["title", "date", "tags", "categories"];
const OPTIONAL_STELLAR_FIELDS = ["description", "banner", "cover", "permalink"];

module.exports = class HexoStellarNormalizerPlugin extends Plugin {
  async onload() {
    this.fileSnapshots = new Map();
    this.renameTimers = new Map();
    this.renameInProgress = new Set();

    this.addCommand({
      id: "check-current-article",
      name: "Hexo Stellar：检查当前文章",
      callback: () => this.checkCurrentArticle()
    });

    this.addCommand({
      id: "fix-current-article",
      name: "Hexo Stellar：修复当前文章",
      callback: () => this.fixCurrentArticle()
    });

    this.addCommand({
      id: "sync-current-article-image-names",
      name: "Hexo Stellar：同步当前文章图片文件名",
      callback: () => this.syncCurrentArticleImageNames()
    });

    this.registerDomEvent(document, "paste", (event) => this.handlePaste(event), true);

    this.registerEvent(this.app.workspace.on("active-leaf-change", () => {
      this.captureActiveFileSnapshot();
    }));

    this.registerEvent(this.app.vault.on("modify", (file) => {
      if (file instanceof TFile && file.extension === "md") {
        this.scheduleImageRenameSync(file);
      }
    }));

    this.captureActiveFileSnapshot();
  }

  async checkCurrentArticle() {
    const file = this.getActiveMarkdownFile();
    if (!file) return;

    const source = await this.app.vault.read(file);
    const result = analyzeMarkdown(source, file);
    new ReportModal(this.app, "Hexo Stellar 检查结果", result, null).open();
  }

  async fixCurrentArticle() {
    const file = this.getActiveMarkdownFile();
    if (!file) return;

    const source = await this.app.vault.read(file);
    const result = analyzeMarkdown(source, file);

    if (result.issues.length === 0) {
      new Notice("Hexo Stellar：当前文章已经符合基础规范。");
      new ReportModal(this.app, "Hexo Stellar 检查结果", result, null).open();
      return;
    }

    new ReportModal(this.app, "要修复当前文章吗？", result, async () => {
      const fixed = normalizeMarkdown(source, file, {
        resolveImagePath: (target) => resolveImagePath(this.app, file, target)
      });
      await this.app.vault.modify(file, fixed.markdown);
      new Notice(`Hexo Stellar：已修复 ${fixed.changes.length} 项。`);
      new ReportModal(this.app, "Hexo Stellar 修复完成", {
        issues: fixed.changes.map((message) => ({ severity: "已修复", message })),
        warnings: fixed.warnings
      }, null).open();
    }).open();
  }

  async syncCurrentArticleImageNames() {
    const file = this.getActiveMarkdownFile();
    if (!file) return;

    const source = await this.app.vault.read(file);
    const operations = findImageRenameOperations(this.app, file, this.fileSnapshots.get(file.path) || "", source);
    if (operations.length === 0) {
      this.fileSnapshots.set(file.path, source);
      new Notice("Hexo Stellar：没有发现需要同步重命名的图片。");
      return;
    }

    const count = await this.applyImageRenameOperations(file, operations);
    this.fileSnapshots.set(file.path, source);
    new Notice(`Hexo Stellar：已同步重命名 ${count} 张图片。`);
  }

  async handlePaste(event) {
    const file = this.getActiveMarkdownFile(false);
    if (!file || !event.clipboardData) return;

    const imageItems = Array.from(event.clipboardData.items || [])
      .filter((item) => item.kind === "file" && item.type.startsWith("image/"));
    if (imageItems.length === 0) return;

    const editor = this.app.workspace.activeEditor && this.app.workspace.activeEditor.editor;
    if (!editor) return;

    event.preventDefault();
    event.stopPropagation();

    const links = [];
    for (const item of imageItems) {
      const blob = item.getAsFile();
      if (!blob) continue;
      const saved = await this.saveClipboardImage(file, blob);
      links.push(`![${basenameWithoutExt(saved.fileName)}](${saved.markdownPath})`);
    }

    if (links.length > 0) {
      editor.replaceSelection(links.join("\n"));
      const current = await this.app.vault.read(file);
      this.fileSnapshots.set(file.path, current);
      new Notice(`Hexo Stellar：已保存 ${links.length} 张图片到文章同名文件夹。`);
    }
  }

  async saveClipboardImage(file, blob) {
    const folderPath = articleAssetFolderPath(file);
    await ensureFolder(this.app, folderPath);

    const extension = imageExtensionFromType(blob.type);
    const fileName = await nextImageFileName(this.app, folderPath, extension);
    const imagePath = joinVaultPath(folderPath, fileName);
    const buffer = await blob.arrayBuffer();
    await this.app.vault.createBinary(imagePath, buffer);

    return {
      fileName,
      markdownPath: toMarkdownRelativeImagePath(relativePathFromFile(file.path, imagePath))
    };
  }

  async captureActiveFileSnapshot() {
    const file = this.getActiveMarkdownFile(false);
    if (!file) return;
    try {
      this.fileSnapshots.set(file.path, await this.app.vault.read(file));
    } catch (_error) {
      // Ignore transient file reads while Obsidian is switching panes.
    }
  }

  scheduleImageRenameSync(file) {
    if (this.renameInProgress.has(file.path)) return;
    window.clearTimeout(this.renameTimers.get(file.path));
    const timer = window.setTimeout(async () => {
      await this.handleImageRenameSync(file);
    }, 800);
    this.renameTimers.set(file.path, timer);
  }

  async handleImageRenameSync(file) {
    if (this.renameInProgress.has(file.path)) return;
    const previous = this.fileSnapshots.get(file.path);
    let current = "";

    try {
      current = await this.app.vault.read(file);
    } catch (_error) {
      return;
    }

    if (!previous) {
      this.fileSnapshots.set(file.path, current);
      return;
    }

    const operations = findImageRenameOperations(this.app, file, previous, current);
    if (operations.length === 0) {
      this.fileSnapshots.set(file.path, current);
      return;
    }

    const count = await this.applyImageRenameOperations(file, operations);
    this.fileSnapshots.set(file.path, current);
    if (count > 0) {
      new Notice(`Hexo Stellar：已同步重命名 ${count} 张图片。`);
    }
  }

  async applyImageRenameOperations(file, operations) {
    let count = 0;
    this.renameInProgress.add(file.path);
    try {
      for (const operation of operations) {
        const oldFile = this.app.vault.getAbstractFileByPath(operation.oldPath);
        const existingNewFile = this.app.vault.getAbstractFileByPath(operation.newPath);
        if (!(oldFile instanceof TFile) || existingNewFile) continue;
        await this.app.vault.rename(oldFile, operation.newPath);
        count += 1;
      }
    } finally {
      this.renameInProgress.delete(file.path);
    }
    return count;
  }

  getActiveMarkdownFile(showNotice = true) {
    const file = this.app.workspace.getActiveFile();
    if (!(file instanceof TFile) || file.extension !== "md") {
      if (showNotice) {
        new Notice("Hexo Stellar：请先打开一个 Markdown 文件。");
      }
      return null;
    }
    return file;
  }
};

class ReportModal extends Modal {
  constructor(app, title, result, onConfirm) {
    super(app);
    this.title = title;
    this.result = result;
    this.onConfirm = onConfirm;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("hexo-stellar-normalizer-modal");

    contentEl.createEl("h2", { text: this.title });

    const issueCount = this.result.issues.length;
    const warningCount = this.result.warnings.length;
    contentEl.createEl("p", {
      cls: "hexo-stellar-normalizer-summary",
      text: issueCount === 0
        ? `没有发现必须修复的问题。另有 ${warningCount} 条建议。`
        : `发现 ${issueCount} 个问题，另有 ${warningCount} 条建议。`
    });

    if (issueCount > 0) {
      contentEl.createEl("h3", { text: "问题" });
      const list = contentEl.createEl("ul", { cls: "hexo-stellar-normalizer-list" });
      for (const issue of this.result.issues) {
        list.createEl("li", { text: `[${issue.severity}] ${issue.message}` });
      }
    }

    if (warningCount > 0) {
      contentEl.createEl("h3", { text: "建议" });
      const list = contentEl.createEl("ul", { cls: "hexo-stellar-normalizer-list" });
      for (const warning of this.result.warnings) {
        list.createEl("li", { text: warning });
      }
    }

    const actions = contentEl.createDiv({ cls: "hexo-stellar-normalizer-actions" });
    const closeButton = actions.createEl("button", { text: this.onConfirm ? "取消" : "关闭" });
    closeButton.addEventListener("click", () => this.close());

    if (this.onConfirm) {
      const fixButton = actions.createEl("button", {
        text: "修复当前文件",
        cls: "mod-cta"
      });
      fixButton.addEventListener("click", async () => {
        this.close();
        await this.onConfirm();
      });
    }
  }
}

function analyzeMarkdown(source, file) {
  const issues = [];
  const warnings = [];
  const parsed = parseFrontmatter(source);

  if (!parsed.frontmatter) {
    issues.push({ severity: "错误", message: "缺少 YAML frontmatter。" });
  }

  const data = parseYamlLikeFrontmatter(parsed.frontmatter || "");
  for (const field of REQUIRED_FIELDS) {
    if (!hasValue(data[field])) {
      issues.push({ severity: "错误", message: `缺少必需 frontmatter 字段：${field}。` });
    }
  }

  const wikilinks = collectMatches(parsed.body, /(?<!!)\[\[([^\]\n]+)\]\]/g);
  if (wikilinks.length > 0) {
    issues.push({
      severity: "警告",
      message: `发现 ${wikilinks.length} 个 Obsidian 双链，需要转换为标准 Markdown 链接。`
    });
  }

  const embeds = collectMatches(parsed.body, /!\[\[([^\]\n]+)\]\]/g);
  if (embeds.length > 0) {
    issues.push({
      severity: "警告",
      message: `发现 ${embeds.length} 个 Obsidian 嵌入，需要转换为 Hexo 资源链接。`
    });
  }

  const inlineTags = collectInlineTags(parsed.body);
  if (inlineTags.length > 0) {
    issues.push({
      severity: "警告",
      message: `正文中的行内标签应迁移到 frontmatter tags：${inlineTags.join(", ")}。`
    });
  }

  if (parsed.frontmatter) {
    for (const field of OPTIONAL_STELLAR_FIELDS) {
      if (!hasValue(data[field])) {
        warnings.push(`未设置 Stellar 常用可选字段：${field}。`);
      }
    }
  }

  if (file && file.path.includes(" ")) {
    warnings.push("文件路径包含空格；Hexo 可以处理，但更稳定的 slug/permalink 会更干净。");
  }

  return { issues, warnings };
}

function normalizeMarkdown(source, file, options = {}) {
  const parsed = parseFrontmatter(source);
  const title = inferTitle(file, parsed.body);
  const today = new Date().toISOString().slice(0, 10);
  const postAssetDir = basenameWithoutExt(file.basename || title);
  const data = parseYamlLikeFrontmatter(parsed.frontmatter || "");
  const changes = [];
  const warnings = [];

  if (!parsed.frontmatter) {
    changes.push("已添加 YAML frontmatter。");
  }

  if (!hasValue(data.title)) {
    data.title = title;
    changes.push("已添加 title。");
  }

  if (!hasValue(data.date)) {
    data.date = today;
    changes.push("已添加 date。");
  }

  const inlineTags = collectInlineTags(parsed.body);
  const tagValues = uniqueStrings([...asArray(data.tags), ...inlineTags]);
  if (!hasValue(data.tags) || inlineTags.length > 0 || !Array.isArray(data.tags)) {
    data.tags = tagValues.length > 0 ? tagValues : [];
    changes.push("已将 tags 规范为 YAML 数组。");
  }

  if (!hasValue(data.categories)) {
    data.categories = inferCategories(data.tags);
    changes.push("已添加 categories。");
  } else if (!Array.isArray(data.categories)) {
    data.categories = asArray(data.categories);
    changes.push("已将 categories 规范为 YAML 数组。");
  }

  let body = parsed.body;

  body = body.replace(/!\[\[([^\]\n]+)\]\]/g, (_match, rawTarget) => {
    const target = normalizeTarget(rawTarget);
    const cleanTarget = stripBlockOrAlias(target);
    const resolvedPath = options.resolveImagePath ? options.resolveImagePath(cleanTarget) : null;
    const encoded = resolvedPath
      ? toMarkdownRelativeImagePath(relativePathFromFile(file.path, resolvedPath))
      : toMarkdownRelativeImagePath(`${postAssetDir}/${cleanTarget}`);
    const alt = basenameWithoutExt(cleanTarget.split("/").pop() || "image");
    changes.push(resolvedPath ? `已转换图片嵌入并校正路径：${rawTarget}` : `已转换图片嵌入：${rawTarget}`);
    if (!resolvedPath) {
      warnings.push(`未能确认图片真实位置，请检查：${rawTarget}`);
    }
    return `![${alt}](${encoded})`;
  });

  body = body.replace(/!\[([^\]\n]*)\]\((?!https?:\/\/|data:|#)([^)\n]+)\)/g, (match, alt, rawPath) => {
    const target = decodeMarkdownPath(rawPath.trim());
    const resolvedPath = options.resolveImagePath ? options.resolveImagePath(target) : null;
    if (!resolvedPath) return match;

    const corrected = toMarkdownRelativeImagePath(relativePathFromFile(file.path, resolvedPath));
    if (corrected === rawPath.trim()) return match;

    changes.push(`已校正图片路径：${rawPath.trim()} -> ${corrected}`);
    return `![${alt}](${corrected})`;
  });

  body = body.replace(/(?<!!)\[\[([^\]\n]+)\]\]/g, (_match, rawTarget) => {
    const target = normalizeTarget(rawTarget);
    const [linkTarget, alias] = splitAlias(target);
    const cleanTarget = stripBlockOrAlias(linkTarget);
    const text = alias || cleanTarget.replace(/#/g, " - ");
    changes.push(`已转换双链：${rawTarget}`);
    return `[${text}](${encodeMarkdownPath(cleanTarget)})`;
  });

  if (inlineTags.length > 0) {
    body = removeInlineTags(body);
    changes.push("已移除正文行内标签，并迁移到 frontmatter。");
  }

  const frontmatter = stringifyFrontmatter(data);
  return {
    markdown: `---\n${frontmatter}---\n${body.replace(/^\n+/, "")}`,
    changes: uniqueStrings(changes),
    warnings
  };
}

function parseFrontmatter(source) {
  const normalized = source.replace(/^\uFEFF/, "");
  const match = normalized.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) {
    return { frontmatter: "", body: normalized };
  }
  return {
    frontmatter: match[1],
    body: normalized.slice(match[0].length)
  };
}

function parseYamlLikeFrontmatter(frontmatter) {
  const result = {};
  const lines = frontmatter.split(/\r?\n/);

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const top = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!top) continue;

    const key = top[1];
    const raw = top[2].trim();

    if (raw === "") {
      const items = [];
      let j = i + 1;
      while (j < lines.length) {
        const item = lines[j].match(/^\s*-\s+(.+)\s*$/);
        if (!item) break;
        items.push(unquote(item[1].trim()));
        j += 1;
      }
      result[key] = items.length > 0 ? items : "";
      i = j - 1;
      continue;
    }

    if (raw.startsWith("[") && raw.endsWith("]")) {
      result[key] = raw.slice(1, -1)
        .split(",")
        .map((item) => unquote(item.trim()))
        .filter(Boolean);
      continue;
    }

    result[key] = unquote(raw);
  }

  return result;
}

function stringifyFrontmatter(data) {
  const orderedKeys = [
    "title",
    "date",
    "tags",
    "categories",
    "description",
    "banner",
    "cover",
    "permalink",
    "menu_id",
    "indexing"
  ];
  const keys = uniqueStrings([...orderedKeys, ...Object.keys(data)]);
  const lines = [];

  for (const key of keys) {
    if (!(key in data)) continue;
    const value = data[key];
    if (Array.isArray(value)) {
      lines.push(`${key}: [${value.map(formatScalar).join(", ")}]`);
    } else if (value === "") {
      lines.push(`${key}:`);
    } else {
      lines.push(`${key}: ${formatScalar(value)}`);
    }
  }

  return `${lines.join("\n")}\n`;
}

function collectMatches(text, regex) {
  return Array.from(text.matchAll(regex));
}

function collectInlineTags(body) {
  const tags = new Set();
  const lines = body.split(/\r?\n/);
  let inFence = false;

  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    const matches = line.matchAll(/(^|[\s([{])#([A-Za-z0-9_\-\u4e00-\u9fa5]+)(?=$|[\s.,;:!?，。；：！？)\]}])/g);
    for (const match of matches) {
      tags.add(match[2]);
    }
  }

  return Array.from(tags);
}

function removeInlineTags(body) {
  const lines = body.split(/\r?\n/);
  let inFence = false;

  return lines.map((line) => {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      return line;
    }
    if (inFence) return line;
    return line
      .replace(/(^|[\s([{])#([A-Za-z0-9_\-\u4e00-\u9fa5]+)(?=$|[\s.,;:!?，。；：！？)\]}])/g, "$1")
      .replace(/[ \t]{2,}/g, " ")
      .trimEnd();
  }).join("\n");
}

function inferTitle(file, body) {
  if (file && file.basename) return file.basename;
  const heading = body.match(/^#\s+(.+)$/m);
  return heading ? heading[1].trim() : "Untitled";
}

function inferCategories(tags) {
  const values = asArray(tags);
  return values.length > 0 ? [values[0]] : [];
}

function normalizeTarget(target) {
  return target.trim().replace(/\\/g, "/");
}

function splitAlias(target) {
  const parts = target.split("|");
  return [parts[0].trim(), parts.slice(1).join("|").trim()];
}

function stripBlockOrAlias(target) {
  return splitAlias(target)[0].trim();
}

function resolveImagePath(app, file, target) {
  const cleanTarget = stripBlockOrAlias(decodeMarkdownPath(normalizeTarget(target)));
  const direct = app.metadataCache.getFirstLinkpathDest(cleanTarget, file.path);
  if (direct) return direct.path;

  const withoutCurrentDir = cleanTarget.split("/").pop();
  if (withoutCurrentDir) {
    const byName = app.metadataCache.getFirstLinkpathDest(withoutCurrentDir, file.path);
    if (byName) return byName.path;
  }

  const candidates = app.vault.getFiles()
    .filter((candidate) => candidate.extension && isImageExtension(candidate.extension))
    .filter((candidate) => {
      const candidateName = candidate.name.toLowerCase();
      return candidateName === String(withoutCurrentDir || cleanTarget).toLowerCase();
    });

  if (candidates.length === 1) return candidates[0].path;

  const fileFolder = parentFolder(file.path);
  const sameFolder = candidates.find((candidate) => parentFolder(candidate.path) === fileFolder);
  if (sameFolder) return sameFolder.path;

  return null;
}

function findImageRenameOperations(app, file, previousSource, currentSource) {
  const previousLinks = extractMarkdownImageLinks(previousSource);
  const currentLinks = extractMarkdownImageLinks(currentSource);
  const operations = [];
  const count = Math.min(previousLinks.length, currentLinks.length);

  for (let index = 0; index < count; index += 1) {
    const previous = previousLinks[index];
    const current = currentLinks[index];
    if (previous.target === current.target) continue;
    if (!isLocalImageTarget(previous.target) || !isLocalImageTarget(current.target)) continue;

    const oldPath = resolveImagePath(app, file, previous.target) || markdownTargetToVaultPath(file.path, previous.target);
    const newPath = markdownTargetToVaultPath(file.path, current.target);
    if (!oldPath || !newPath || oldPath === newPath) continue;
    if (parentFolder(oldPath) !== parentFolder(newPath)) continue;
    if (!isImageExtension(oldPath.split(".").pop()) || !isImageExtension(newPath.split(".").pop())) continue;

    operations.push({ oldPath, newPath });
  }

  return operations;
}

function extractMarkdownImageLinks(source) {
  const parsed = parseFrontmatter(source);
  const links = [];
  const regex = /!\[([^\]\n]*)\]\((?!https?:\/\/|data:|#)([^)\n]+)\)/g;
  for (const match of parsed.body.matchAll(regex)) {
    links.push({
      alt: match[1],
      target: decodeMarkdownPath(match[2].trim()),
      raw: match[0]
    });
  }
  return links;
}

function markdownTargetToVaultPath(fromFilePath, target) {
  const cleanTarget = decodeMarkdownPath(String(target).trim()).replace(/^<|>$/g, "");
  if (!cleanTarget || cleanTarget.startsWith("/") || /^[a-z]+:/i.test(cleanTarget)) return null;
  const fromFolder = parentFolder(fromFilePath);
  const base = cleanTarget.startsWith("./") || cleanTarget.startsWith("../")
    ? joinVaultPath(fromFolder, cleanTarget)
    : joinVaultPath(fromFolder, cleanTarget);
  return normalizeVaultPath(base);
}

async function ensureFolder(app, folderPath) {
  const parts = folderPath.split("/").filter(Boolean);
  let current = "";
  for (const part of parts) {
    current = current ? `${current}/${part}` : part;
    if (!app.vault.getAbstractFileByPath(current)) {
      await app.vault.createFolder(current);
    }
  }
}

function articleAssetFolderPath(file) {
  return joinVaultPath(parentFolder(file.path), file.basename);
}

async function nextImageFileName(app, folderPath, extension) {
  let index = 0;
  while (index < 10000) {
    const fileName = index === 0 ? `image.${extension}` : `image-${index}.${extension}`;
    const candidate = joinVaultPath(folderPath, fileName);
    if (!app.vault.getAbstractFileByPath(candidate)) {
      return fileName;
    }
    index += 1;
  }
  return `image-${Date.now()}.${extension}`;
}

function imageExtensionFromType(type) {
  const normalized = String(type || "").toLowerCase();
  if (normalized.includes("jpeg")) return "jpg";
  if (normalized.includes("png")) return "png";
  if (normalized.includes("gif")) return "gif";
  if (normalized.includes("webp")) return "webp";
  if (normalized.includes("svg")) return "svg";
  if (normalized.includes("avif")) return "avif";
  return "png";
}

function isLocalImageTarget(target) {
  const cleanTarget = String(target || "").trim();
  if (!cleanTarget || cleanTarget.startsWith("#")) return false;
  if (/^(https?:|data:|mailto:)/i.test(cleanTarget)) return false;
  const extension = cleanTarget.split("?")[0].split("#")[0].split(".").pop();
  return isImageExtension(extension);
}

function joinVaultPath(...parts) {
  return normalizeVaultPath(parts.filter((part) => part !== undefined && part !== null && String(part) !== "").join("/"));
}

function normalizeVaultPath(path) {
  const absolute = String(path || "").replace(/\\/g, "/");
  const segments = [];
  for (const segment of absolute.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return segments.join("/");
}

function relativePathFromFile(fromFilePath, toFilePath) {
  const fromParts = parentFolder(fromFilePath).split("/").filter(Boolean);
  const toParts = toFilePath.split("/").filter(Boolean);

  while (fromParts.length > 0 && toParts.length > 0 && fromParts[0] === toParts[0]) {
    fromParts.shift();
    toParts.shift();
  }

  return [...fromParts.map(() => ".."), ...toParts].join("/") || toFilePath.split("/").pop();
}

function toMarkdownRelativeImagePath(path) {
  const encoded = encodeMarkdownPath(path);
  if (encoded.startsWith("./") || encoded.startsWith("../") || encoded.startsWith("/")) {
    return encoded;
  }
  return encoded.includes("/") ? `./${encoded}` : encoded;
}

function parentFolder(filePath) {
  const parts = String(filePath || "").split("/");
  parts.pop();
  return parts.join("/");
}

function isImageExtension(extension) {
  return ["png", "jpg", "jpeg", "gif", "webp", "svg", "avif", "bmp"].includes(String(extension).toLowerCase());
}

function decodeMarkdownPath(path) {
  try {
    return decodeURI(String(path).replace(/^<|>$/g, ""));
  } catch (_error) {
    return String(path).replace(/^<|>$/g, "");
  }
}

function encodeMarkdownPath(path) {
  return path
    .split("/")
    .map((part) => encodeURI(part).replace(/[()]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`))
    .join("/");
}

function basenameWithoutExt(name) {
  return String(name).replace(/\.[^.]+$/, "");
}

function asArray(value) {
  if (Array.isArray(value)) return value.filter(Boolean).map(String);
  if (!hasValue(value)) return [];
  return [String(value)];
}

function hasValue(value) {
  if (Array.isArray(value)) return value.length > 0;
  return value !== undefined && value !== null && String(value).trim() !== "";
}

function uniqueStrings(values) {
  return Array.from(new Set(values.filter(Boolean).map((value) => String(value).trim()).filter(Boolean)));
}

function unquote(value) {
  return value.replace(/^['"]|['"]$/g, "");
}

function formatScalar(value) {
  const text = String(value);
  if (text === "") return "''";
  if (/^[A-Za-z0-9_\-./:/]+$/.test(text)) return text;
  return JSON.stringify(text);
}
