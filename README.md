# dsh-UEAssetsOperator

面向 DeepSeek Harness（DSH）的 Unreal Engine `.uasset` 检查与蓝图节点编辑插件。

- `lib/index.js` 导出 `name`、`inject` 和 `apply`。
- 通过 `ctx.tools.register()` 注册原生工具 `ue_uasset_inspect` 和
  `ue_blueprint_python_edit`。
- 通过 `ctx.skills.register()` 注册配套的 DSH 内置操作说明。
- `skills/ue-uasset-operator` 保存 PowerShell 启动器、Unreal Python
  检查器、受限蓝图编辑脚本及参考文档。

插件支持三种检查模式：

| 模式 | 行为 |
|---|---|
| `resolve` | 只解析 `.uproject`、UE 版本和虚拟包路径，不启动 UE |
| `registry` | 通过 Asset Registry 读取类型、标签、依赖和引用，默认模式 |
| `load` | 加载 UObject，额外读取选定属性和元数据 |

## 安装到 DSH 环境

1. 将本仓库克隆或复制到固定目录，例如：

   ```powershell
   git clone https://github.com/QSWWLTN/dsh-UEAssetsOperator.git X:\Tools\dsh-UEAssetsOperator
   cd X:\Tools\dsh-UEAssetsOperator
   npm install --omit=dev
   ```

2. 新建一个 DSH patch 文件，例如 `ue-assets.patch.yml`：

   ```yaml
   - insert:
       - id: ue-uasset-operator
         name: 'file:///X:/Tools/dsh-UEAssetsOperator/lib/index.js'
   ```

   `name` 必须是 `lib/index.js` 的绝对 `file:` URL。Windows 盘符路径写成
   `file:///X:/...`，路径中的空格应进行 URL 编码。

3. 启动 DSH 并加载该 patch：

   ```powershell
   dsh web --patch X:\Tools\ue-assets.patch.yml --host 127.0.0.1 --port 0
   ```

4. 在 DSH 的插件清单中确认 `ue-uasset-operator` 已加载。随后模型可以调用
   `ue_uasset_inspect` 和 `ue_blueprint_python_edit`；也可以显式调用
   `ue-uasset-operator` 配套技能。


## 前置条件

目标 `.uasset` 通常应位于项目或插件的 `Content` 目录中，并保留同名
`.uexp`、`.ubulk`、`.uptnl` sidecar。项目需要安装匹配的 Unreal Editor，
且 `PythonScriptPlugin` 应已启用；插件不会自动修改 `.uproject`。

## 开发验证

在插件目录运行：

```powershell
npm test
```
