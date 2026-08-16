# Project Editor Commandlets for Blueprint graph authoring

## Contents

- [Preconditions](#preconditions)
- [Design the Commandlet files](#design-the-commandlet-files)
- [Implement task-specific graph edits](#implement-task-specific-graph-edits)
- [Animation Blueprint patterns](#animation-blueprint-patterns)
- [Module dependencies](#module-dependencies)
- [Build and execute](#build-and-execute)
- [Verify and report](#verify-and-report)
- [Clean up task artifacts](#clean-up-task-artifacts)
- [Primary references](#primary-references)

Use this route when built-in Unreal Python cannot perform the requested standard
Blueprint or Animation Blueprint graph edit. Do not pause for a separate user
authorization; the current edit request is the go signal. This adds code to an
existing project Editor module; it does not add an engine plugin.

## Preconditions

- Resolve the exact `.uproject`, engine association, Editor target, target
  `.uasset`, virtual object path, and every additional asset that may be saved.
- Require an existing C++ Editor module registered with `"Type": "Editor"`.
  Do not silently create a module or convert a Blueprint-only project.
- Require a working compiler/toolchain for the project's exact engine build.
- Require a headless build and execution route. Do not open Unreal Editor,
  Visual Studio, a visible terminal, a modal dialog, or any UI automation.
- Proceed directly after Python reports a limitation: do not ask for separate
  authorization for task-owned project source edits, `Build.cs` changes,
  Editor-target builds, or the named asset writes. Treat the current Blueprint
  edit request as that authorization.
- Do not stop another Editor/build process automatically. Report DLL locks and
  ask the user to close the relevant process.

If any precondition fails, explain the missing requirement and do not fall back
to raw `.uasset` editing, UI click automation, or a different engine version.

## Design the Commandlet files

Create one task-specific `UCommandlet` declaration and implementation in the
existing Editor module. Prefer the bundled minimal scaffold generator:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File `
  <skill-root>\scripts\New-BlueprintCommandlet.ps1 `
  -EditorModuleRoot X:\Project\Source\GameEditor `
  -CommandletName DSHModifyLocomotion `
  -ModuleApi GAMEEDITOR_API
```

It creates only an inert commandlet shell and always refuses to overwrite
existing files. Example output paths:

```text
Source/GameEditor/Public/GeneratedCommandlets/DSHModifyLocomotionCommandlet.h
Source/GameEditor/Private/GeneratedCommandlets/DSHModifyLocomotionCommandlet.cpp
```

The header must declare a reflected class derived from `UCommandlet`, include
its generated header, and override `Main`. The implementation must:

- require exactly one of `-ValidateOnly` or `-Apply`;
- require an exact Blueprint object path and reject unrecognized parameters;
- load and type-check the Blueprint, graphs, schemas and related assets;
- keep validation free of UObject mutations and package saves;
- return nonzero on any missing asset, graph, node, pin, connection, compile or
  save failure;
- maintain a local explicit `PackagesToSave` collection;
- mark and compile the primary Blueprint without an implicit save;
- save only the explicit task save set after compilation succeeds.

The generated `-Apply` branch deliberately returns an error until task logic is
implemented. Generate only the code required by the current task. Keep the
detailed graph, pin and type rules in this Skill's references rather than
expanding the scaffold into a universal implementation or broad helper library.

## Implement task-specific graph edits

In validation mode, load and verify every referenced object without calling
`Modify`, spawning/removing nodes, changing assets, reconstructing nodes, or
saving packages. Report missing graphs, schema types, functions, animations,
pins, state graphs, and package write targets together when possible.

In apply mode:

1. Call `Modify()` on each object that will change.
2. Create ordinary graph nodes with `FGraphNodeCreator` and call `Finalize()`.
3. Use the graph-specific schema actions for nodes that require them. Animation
   state and transition nodes commonly use
   `FEdGraphSchemaAction_NewStateNode::SpawnNodeFromTemplate`.
4. Configure node assets/properties, add dynamic pins, then call
   `ReconstructNode()` when the node type requires it.
5. Resolve pins by exact name and direction. Treat a missing pin as an error.
6. Connect through the owning graph schema's `TryCreateConnection`; treat a
   false result as an error and do not save.
7. Add every modified Blueprint, BlendSpace, animation, or other asset package
   to `PackagesToSave`. Never use “save all dirty packages.”
8. Let the Commandlet's outer workflow structurally mark, compile, and save the
   primary Blueprint only after the task returns success.

Use type-specific APIs for Animation Blueprints, state machines, transition
graphs, material graphs, Control Rig, Niagara, and other graph systems. Do not
assume K2 node creation rules apply to every graph schema.

### Animation Blueprint patterns

For an Animation Blueprint task, cast the loaded asset to `UAnimBlueprint`, call
`GetAllGraphs`, and verify the target graph class/name before mutation. Use the
following creation routes rather than constructing graph UObjects manually:

```cpp
FGraphNodeCreator<UAnimGraphNode_StateMachine> Creator(*AnimGraph);
UAnimGraphNode_StateMachine* Node = Creator.CreateNode();
Creator.Finalize();

UAnimStateNode* State =
    FEdGraphSchemaAction_NewStateNode::SpawnNodeFromTemplate<UAnimStateNode>(
        StateMachineGraph, NewObject<UAnimStateNode>(), Position, false);
```

Create transitions through the same state-machine schema action, then call
`CreateConnections(FromState, ToState)`. Use `FGraphNodeCreator` for sequence
players, BlendSpace players, function-call nodes, cached poses, and ordinary
AnimGraph nodes. Configure their assets and dynamic inputs before
`ReconstructNode`; add Blend List inputs through `AddPinToBlendList`.

Resolve every pin by exact name and direction, then connect through the current
graph's schema:

```cpp
UEdGraphPin* Output = SourceNode->FindPin(OutputName, EGPD_Output);
UEdGraphPin* Input = TargetNode->FindPin(InputName, EGPD_Input);
const bool bConnected = Output && Input &&
    SourceNode->GetGraph()->GetSchema()->TryCreateConnection(Output, Input);
```

For transition rules, create the function-call node in the transition's bound
rule graph and connect its boolean return to the Transition Result pin. Use
`bAutomaticRuleBasedOnSequencePlayerInState` only for a transition whose source
state has the intended non-looping sequence-player semantics.

When modifying a `UBlendSpace`, validate every animation and sample coordinate,
then use `DeleteSample`, `AddSample`, `ValidateSampleData`, and `ResampleData`.
Add the BlendSpace package to `PackagesToSave`; compiling the Anim Blueprint does
not implicitly save that separate asset.

## Module dependencies

Inspect the actual includes and add only required dependencies to the existing
Editor module's `Build.cs`. Typical Blueprint/Animation Blueprint tasks may need
some of:

```csharp
PrivateDependencyModuleNames.AddRange(new[]
{
    "Core",
    "CoreUObject",
    "Engine",
    "UnrealEd",
    "BlueprintGraph",
    "KismetCompiler",
    "AnimGraph",
    "AnimGraphRuntime",
    "GameRuntimeModule"
});
```

Do not paste this list blindly. Resolve the defining module for each header and
preserve unrelated `Build.cs` content. Do not place editor-only dependencies in
a Runtime module.

## Build and execute

Discover the exact `*Editor.Target.cs` name and matching engine root. Build with
that engine's UBT wrapper, for example:

```powershell
<Engine>\Engine\Build\BatchFiles\Build.bat GameEditor Win64 Development `
  -Project=X:\Project\Game.uproject -WaitMutex -NoHotReloadFromIDE
```

Run the build and Unreal processes through the automation host's hidden child
process facility. Capture stdout and stderr. With `ProcessStartInfo`, require
`UseShellExecute=false`, `CreateNoWindow=true`, and redirected output. Do not use
`start`, open an IDE, or invoke `Start-Process` without a hidden window setting.

Run validation first:

```powershell
<Engine>\Engine\Binaries\Win64\UnrealEditor-Cmd.exe `
  X:\Project\Game.uproject `
  -run=DSHModifyLocomotion `
  -Asset=/Game/Characters/BP_Anim.BP_Anim `
  -ValidateOnly -unattended -nop4 -nosplash -nullrhi -NoSound `
  -stdout -FullStdOutLogOutput -UTF8Output
```

Do not run `-Apply` unless validation succeeds and its report enumerates the
same asset/package set from the current request and the validated Commandlet.
Back up every package and sidecar outside `Content`, then run the same command
with `-Apply`.

Never substitute `UnrealEditor.exe` if the command editor fails. If Unreal tries
to show a prompt, opens a window, requests interactive authentication, or hangs
waiting for input, terminate the process tree after the configured timeout and
report the blocking requirement to the user.

## Verify and report

- Require process exit code zero and no Blueprint compile error.
- Confirm only expected source, binaries, `.uasset`, and sidecar files changed.
- Reopen or inspect the exact Blueprint and report node/graph/connection counts
  relevant to the task.
- Report generated source paths, `Build.cs` changes, build target, command line,
  backups, packages saved, and verification results.
- On failure, preserve logs and backups, state whether anything was saved, and
  stop. Do not keep rewriting or rerunning automatically after repeated compile
  or graph-schema errors.

Keep generated Commandlet source through verification. Then follow the cleanup
phase below unless the user explicitly asks to retain it. Removing source
without rebuilding can leave a stale compiled class.

## Clean up task artifacts

Enter this phase after successful verification or after a terminal failure,
unless the user explicitly requested that the generated Commandlet remain in
the project. Cleanup is best-effort and must never hide the primary result.

1. Preserve asset backups, validation reports and relevant Unreal/build logs.
2. Record the exact generated header, source and task-owned `Build.cs` changes.
3. Run the bundled cleanup helper only for a scaffold created by this Skill:

   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File `
     <skill-root>\scripts\Remove-BlueprintCommandletScaffold.ps1 `
     -EditorModuleRoot X:\Project\Source\GameEditor `
     -CommandletName DSHModifyLocomotion `
     -ConfirmCleanup
   ```

   The helper resolves two exact paths below the Editor module and refuses to
   remove a file without the scaffold marker. It does not edit `Build.cs` or
   delete build directories.
4. Revert only dependency entries that were added solely for this task. Never
   replace the whole `Build.cs`, discard unrelated work, or guess at ownership.
5. Rebuild the exact Editor target so the temporary reflected class is removed
   from the module binary, using the same hidden process policy. Do not broadly
   wipe `Binaries`, `Intermediate` or `Saved` as a cleanup shortcut.
6. Confirm the generated source is absent, the Editor target still builds, and
   the modified assets still compile/load. Report any locked file, stale binary,
   dependency line or temporary path that could not be cleaned.

If cleanup would remove a pre-existing file, conflict with unrelated edits, or
destroy the only diagnostic evidence, skip that item and explain why.

## Primary references

- [UCommandlet API](https://dev.epicgames.com/documentation/en-us/unreal-engine/API/Runtime/Engine/UCommandlet)
- [Setting up Editor modules](https://dev.epicgames.com/documentation/en-us/unreal-engine/setting-up-editor-modules-for-customizing-the-editor-in-unreal-engine)
- [Unreal Engine modules](https://dev.epicgames.com/documentation/unreal-engine/unreal-engine-modules)
- [Unreal Build Tool](https://dev.epicgames.com/documentation/unreal-engine/unreal-build-tool-in-unreal-engine)
