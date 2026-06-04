# Hexo Stellar Normalizer

一个给 Obsidian 用的本地插件，用来把笔记整理成 Hexo + Stellar 博客主题更容易识别的 Markdown 格式。

## 功能

- 检查并补齐 Hexo 文章常用 frontmatter：`title`、`date`、`tags`、`categories`。
- 将 Obsidian 双链 `[[Page]]`、`[[Page|Alias]]` 转换为标准 Markdown 链接。
- 将 Obsidian 图片嵌入 `![[image.png]]` 转换为 Hexo/Stellar 可用的 Markdown 图片链接。
- 粘贴剪贴板图片时，自动保存到与当前文章同名的同级文件夹。
- 当你在文章里修改图片链接文件名时，尝试同步重命名真实图片文件。
- 将正文里的 `#tag` 合并进 frontmatter 的 `tags`。

## 适用场景

这个插件主要面向这类 Hexo 文章结构：

```text
source/_posts/
├── My Post.md
└── My Post/
    └── image.png
```

文章中的图片链接会尽量规范成：

```md
![image](./My%20Post/image.png)
```

## 安装

下载或复制本仓库中的这几个文件：

- `manifest.json`
- `main.js`
- `styles.css`

放到你的 Obsidian vault：

```text
.obsidian/plugins/hexo-stellar-normalizer/
```

然后重启 Obsidian，或刷新第三方插件列表，并启用 **Hexo Stellar Normalizer**。

## 命令

在 Obsidian 命令面板中可以使用：

- `Hexo Stellar：检查当前文章`
- `Hexo Stellar：修复当前文章`
- `Hexo Stellar：同步当前文章图片文件名`

## 说明

插件不会在保存时自动修复整篇文章。涉及正文格式转换时，会先展示问题摘要，确认后才修改当前文件。
