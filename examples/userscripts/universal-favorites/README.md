# Universal 收藏 Userscript

这是一个示例 userscript（Greasemonkey / Tampermonkey），演示如何在浏览器上使用本库将当前页面保存为“收藏”，并将数据文件上传到 WebDAV 后端。

主要功能：
- 通过脚本菜单配置 WebDAV 地址和凭证
- 配置收藏存储根目录（默认为 `app_data/favorites`）
- 将当前页面保存为 JSON 文件并存储到 WebDAV（使用本项目打包后的 `dist/browser.js`）

使用说明：
1. 将本仓库通过静态服务器发布（例如在项目根运行 `npx http-server . -p 8080`），确保可以通过 `http://localhost:8080/dist/browser.js` 访问到打包好的浏览器包。
2. 在 Tampermonkey/Greasemonkey 中安装 `universal-favorites.user.js`（可直接从本地文件或托管的 URL 安装）。
3. 在浏览器页面使用扩展的菜单（右上脚本图标）配置 WebDAV（`baseUrl`、`username`、`password`）以及收藏根目录（如 `app_data/favorites`）。
4. 使用“保存页面到收藏”菜单即可将当前页面保存到远端 WebDAV。

注意：
- 脚本会尝试通过 `import()` 动态加载 `dist/browser.js`（默认 `https://<当前主机>/dist/browser.js`），若你将包托管在不同位置，可在脚本设置中修改 `libUrl`。
- 如果你的环境不支持 ES 模块动态导入（或浏览器安全策略阻止），也可以将打包的 `browser.js` 放到可跨域加载的位置并在脚本设置中指定其 URL。

文件：
- `universal-favorites.user.js` — userscript 源文件

如需我把脚本打包为可直接安装的 URL（或把 `dist/browser.js` 上传到 CDN 以便示例脚本直接可用），告诉我目标 URL，我可以继续处理。 
