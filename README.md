# dsh-UEAssetsOperator

面向 DeepSeek Harness（DSH）的 Unreal Engine `.uasset` 检查与蓝图节点编辑插件。

- `lib/index.js` 导出 `name`、`inject` 和 `apply`，不需要安装额外 npm
  运行时依赖。
- 通过 `ctx.tools.register()` 注册原生工具 `ue_uasset_inspect` 和
  `ue_blueprint_python_edit`。
- 当用户消息出现 `.uasset` / `.uproject` / `/Game/...`、Blueprint /
  DataTable（含 `蓝图` / `数据表`）等明确意图，或 UE 项目目录中的
  `BP_*` 等资产名时，插件会**主动注入**上述两个工具 schema 和完整
  `ue-uasset-operator` 操作说明，引导模型直接调用原生工具而不是用
  `strings`、十六进制或自写脚本解析 `.uasset`。
- 当宿主提供 `skills` 服务时，通过 `ctx.skills.register()` 注册配套的
  DSH 内置操作说明；仅提供 `tools` 的极简宿主仍可使用原生工具。
- `skills/ue-uasset-operator` 保存 PowerShell 启动器、Unreal Python
  检查器、受限蓝图编辑脚本及参考文档。

插件支持三种检查模式：

| 模式 | 行为 |
|---|---|
| `resolve` | 只解析 `.uproject`、UE 版本和虚拟包路径，不启动 UE |
| `registry` | 通过 Asset Registry 读取类型、标签、依赖和引用，默认模式 |
| `load` | 加载 UObject，额外读取选定属性和元数据 |

## 安装到 EAC

先将仓库克隆或复制到固定目录：

```powershell
git clone https://github.com/QSWWLTN/dsh-UEAssetsOperator.git X:\Tools\dsh-UEAssetsOperator
```

在 `C:\Users\<用户名>\.dsh\profiles\web\cordis.patch.yml` 中加入：

```yaml
- insert:
    - id: ue-uasset-operator
      name: 'file:///X:/Tools/dsh-UEAssetsOperator/lib/index.js'
```

如果已经存在 `id: ue-uasset-operator`，只替换该行的 `name`，不要再添加第二个
insert 块。重启 EAC 后生效。这个入口没有额外 npm 运行时依赖，Cordis、工具
和技能注册表由 EAC 宿主提供。

路径中的空格必须按 URL 规则编码，例如 `Deepseek%20Harness%20EAC`。Windows
盘符路径使用三个斜杠的 `file:///X:/...` 形式。

## 安装到普通 DSH 环境

### 推荐：bundle 安装

插件包含 `cordis.patch.yml` bundle。环境已经安装 `dsh` CLI 与 `pnpm` 时，
可以直接安装到目标 profile：

```powershell
dsh plugin --profile my-profile add X:\Tools\dsh-UEAssetsOperator
```

该命令会把插件安装到 profile 的依赖中，并自动写入
`dsh.profile.bundles`。发布到 npm 后也可以按包名安装：

```powershell
dsh plugin --profile my-profile add @deepseek-dsh-desktop/dsh-ue-uasset-operator
```

EAC 安装包未附带 `pnpm`，应使用上一节的 profile patch 方式。不要同时使用
bundle 和手工 insert 块，否则 DSH 会因重复 loader id 拒绝启动。

### 外部 patch

开发时也可以把同样的 insert 块保存为 `ue-assets.patch.yml`，再启动独立 DSH：

```powershell
dsh web --patch X:\Tools\ue-assets.patch.yml --host 127.0.0.1 --port 0
```

在插件清单中确认 `ue-uasset-operator` 已加载。随后模型可以调用
`ue_uasset_inspect` 和 `ue_blueprint_python_edit`；也可以显式调用
`ue-uasset-operator` 配套技能。

## 极简模式与 Anchored Standard

- 官方极简模式和 `极简模式_win` 会继承全局注册的两个 UE 工具，可以直接
  调用。
- `Anchored Standard` 会按上文规则在检测到 `.uasset` 意图时主动把
  `ue_uasset_inspect` 和 `ue_blueprint_python_edit` 加回当前工具 schema，
  因此命中的那一轮即可直接调用，不必等待解锁。
- 若两个 UE 工具因宿主策略仍未出现，进入提升阶段后先通过
  `skill_search` / `skill_load` 加载 `ue-uasset-operator`；随后调用：

  ```json
  {"toolNames":["ue_uasset_inspect","ue_blueprint_python_edit"]}
  ```

  这是 `dev_tool_search` 的精确解锁参数，工具会从下一轮开始出现。不要把两个
  工具名拼成一个自由文本 `query`，该模式的搜索会要求所有关键词同时命中
  同一个工具。


## 前置条件

目标 `.uasset` 通常应位于项目或插件的 `Content` 目录中，并保留同名
`.uexp`、`.ubulk`、`.uptnl` sidecar。项目需要安装匹配的 Unreal Editor，
且 `PythonScriptPlugin` 应已启用；插件不会自动修改 `.uproject`。

## 开发验证

在插件目录运行：

```powershell
npm test
```
