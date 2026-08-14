# Unreal asset workflows

## Choose the path

| Need | Preferred method | Loads UObject | Writes project |
|---|---|---:|---:|
| Verify paths and engine | `Invoke-UAssetInspection.ps1 -ResolveOnly` | No | No |
| Class, registry tags, dependencies | Default inspector run | No | No |
| Metadata and selected properties | Add `-LoadAsset` | Yes | No |
| Type-specific payload or graph | Matching Unreal Python/C++ API | Usually | Only if explicitly saved |
| Interactive visual check | `UnrealEditor.exe` | Yes | Not unless saved |

## Match the engine

Read `EngineAssociation` from the `.uproject`. Resolve launcher versions from `HKLM:\SOFTWARE\EpicGames\Unreal Engine\<version>` and custom build GUIDs from `HKCU:\Software\Epic Games\Unreal Engine\Builds`. Treat a missing exact association as an error when multiple engines exist. Custom forks may add serialization versions unavailable to a stock editor.

Use `UnrealEditor-Cmd.exe` for UE5 and `UE4Editor-Cmd.exe` for UE4. The commandlet form is:

```powershell
UnrealEditor-Cmd.exe <project.uproject> -run=pythonscript -script=<script.py> -unattended -nop4 -nosplash
```

The Python Editor Script Plugin must already be enabled. The full-editor `-ExecutePythonScript=<script.py>` path is appropriate when the script requires a loaded startup level or editor-only context unavailable to the commandlet.

## Translate package paths

- `<Project>/Content/Foo/Bar.uasset` becomes `/Game/Foo/Bar`.
- `<Project>/Plugins/MyPlugin/Content/Foo.uasset` normally becomes `/MyPlugin/Foo`.
- A package name omits both `.uasset` and the object suffix. An object path usually looks like `/Game/Foo/Bar.Bar`.
- Engine, marketplace, externally mounted, virtualized, and custom plugin content may require an explicit mount path.

## Read safely

Asset Registry reads on-disk package headers and exposes class, package, searchable tags, dependencies, and referencers without loading the asset. Registry tags are saved/header data and may be stale until an asset is resaved. A loaded UObject can expose additional metadata and reflected properties, but loading executes serializers and may initialize project modules.

Keep `.uasset` with any same-basename `.uexp`, `.ubulk`, and `.uptnl` files. Missing bulk sidecars can allow header inspection while making a complete load or export fail.

## Modify safely

1. Confirm the user requested a write and identify exact package names.
2. Check source control or make a recoverable copy outside `Content`.
3. Run a narrow Unreal Python script through the matching editor.
4. Use editor subsystems or Asset Tools; do not patch package bytes.
5. Save only explicitly named loaded assets.
6. Compare changed files, inspect logs, and reopen or re-inspect the result.

Do not automatically enable plugins, upgrade a project, convert assets, fix redirectors, or resave packages as a prerequisite for reading. Each changes project state.

## Diagnose failures

- **Python command is unknown:** enable `PythonScriptPlugin`, restart, and retry.
- **Package version/custom version error:** use the originating engine build or migrate through a supported editor path.
- **Missing class or script package:** enable/build the plugin or game module that defines the asset class.
- **Package not found:** verify physical-to-virtual mount translation and plugin enablement.
- **Bulk data error:** restore matching sidecars or container data.
- **Cooked/encrypted/IoStore content:** generic editor inspection may be incomplete; require the authorized project/build pipeline and keys.
- **Commandlet succeeds but report is missing:** inspect stdout/stderr and Saved/Logs; treat the run as failed.

## Primary documentation

- [Scripting the Unreal Editor Using Python](https://dev.epicgames.com/documentation/en-us/unreal-engine/scripting-the-unreal-editor-using-python)
- [Asset Registry](https://dev.epicgames.com/documentation/en-us/unreal-engine/asset-registry-in-unreal-engine)
- [Unreal Python API](https://dev.epicgames.com/documentation/en-us/unreal-engine/PythonAPI)
