# Blueprint graph rule presets

## Contents

- [Authority order](#authority-order)
- [Graph schema routing](#graph-schema-routing)
- [Node creation presets](#node-creation-presets)
- [Pin lookup rules](#pin-lookup-rules)
- [Connection response rules](#connection-response-rules)
- [Type conversion rules](#type-conversion-rules)
- [Default value rules](#default-value-rules)
- [Function call rules](#function-call-rules)
- [Animation Blueprint rules](#animation-blueprint-rules)
- [Validation checklist](#validation-checklist)

Use these presets when generating a project Editor Commandlet. They are safety
defaults, not a replacement for the target graph's schema. Engine forks and
custom nodes may override every generic assumption.

## Authority order

Resolve disagreements in this order:

1. The exact engine build's headers and implementation.
2. The target graph object's actual `UEdGraphSchema`.
3. The node's allocated pins after `Finalize`/`ReconstructNode`.
4. Reflected function/property signatures.
5. These presets.
6. Human-readable node labels, screenshots, or remembered pin names.

Never use C++ implicit-conversion intuition as proof that two Blueprint pins can
connect. Call `CanCreateConnection`, inspect its response, then call
`TryCreateConnection` only under an explicit connection policy.

## Graph schema routing

| Graph | Typical schema | Creation rule |
|---|---|---|
| Event/function/macro graph | `UEdGraphSchema_K2` | Use K2 nodes and K2 schema validation. |
| Animation graph | `UAnimationGraphSchema` | Use `UAnimGraphNode_*`; validate pose pins through its schema. |
| State machine graph | Animation state-machine schema | Spawn states/transitions with `FEdGraphSchemaAction_NewStateNode`. |
| State result graph | Animation state graph schema | Preserve its generated result node; create players/blends around it. |
| Transition rule graph | `UAnimationTransitionSchema` | Preserve Transition Result and connect a boolean rule. |
| Material graph | `UMaterialGraphSchema` | Use material expression/editor APIs, not K2 nodes. |
| Control Rig/RigVM | RigVM controller/schema | Use the controller API and its undo/compile model. |
| Niagara | Niagara graph/schema | Use Niagara editor APIs and compile pipeline. |

Cast and verify the actual graph/schema before creating anything. A matching
graph name is insufficient.

## Node creation presets

| Need | Preferred construction |
|---|---|
| Ordinary K2/AnimGraph node | `FGraphNodeCreator<T>`, configure identity fields, `Finalize`. |
| Function call | Create `UK2Node_CallFunction`, bind a validated `UFunction`, finalize/reconstruct as required. |
| Member variable get/set | Set `VariableReference` to the exact self/external member before final pin lookup. |
| Event override | Bind `EventReference` to a real `FUNC_BlueprintEvent`; reuse an existing override when present. |
| Dynamic cast | Use the K2 cast node matching object/class semantics; do not replace it with a C++ cast assumption. |
| Branch/sequence | Use their dedicated K2 node types; add dynamic sequence outputs through the node API. |
| Animation state/transition | Spawn through the state-machine schema action, not raw `NewObject` plus `AddNode`. |
| Animation sequence/BlendSpace player | Set the animation asset, loop/play settings, then reconstruct before pin lookup. |
| Blend list | Add inputs through the node's add-pin API before finding `BlendPose_N`. |
| Cached pose | Preserve save/use cached-pose name pairing and uniqueness. |

Treat node-specific construction order as authoritative. Some nodes need their
function/field reference before `Finalize`; others need asset assignment after
`Finalize` followed by `ReconstructNode`. Inspect working engine code when the
order is uncertain.

## Pin lookup rules

- Use `PinName`, never localized display text.
- Require an exact direction (`EGPD_Input` or `EGPD_Output`).
- Look up pins only after final allocation/reconstruction and dynamic-pin adds.
- Reject null, orphaned, hidden task-critical, or cross-graph pins.
- Enumerate actual pins in a validation error when an expected name is absent.
- Require opposite directions; execution output connects to execution input.
- Do not connect directly with `MakeLinkTo`. Let the schema decide.
- Re-resolve pins after any later `ReconstructNode`; old pin pointers may be stale.

Generate small task-local helpers for checked pin lookup, schema connection and
default validation when useful. Keep them specific to the Commandlet instead of
copying a broad prebuilt C++ helper library.

## Connection response rules

Interpret `FPinConnectionResponse.Response` as follows:

| Response | Preset behavior |
|---|---|
| `CONNECT_RESPONSE_MAKE` | Allow. |
| `CONNECT_RESPONSE_DISALLOW` | Reject and surface the schema message. |
| `BREAK_OTHERS_A/B/AB` | Reject by default; allow only when replacing those exact links is in the approved plan. |
| `MAKE_WITH_CONVERSION_NODE` | Reject by default; allow when an implicit conversion node is expected and will be verified. |
| `MAKE_WITH_PROMOTION` | Reject by default; allow when type promotion is expected and the resulting node/pin types will be verified. |

`TryCreateConnection` can break links, insert conversion nodes, or promote pin
types based on this response. A true return means the graph was modified; it
does not mean the resulting gameplay logic matches the request.

When allowing conversion or promotion, snapshot the graph before connection,
then identify and report inserted nodes or changed pin types afterward. Compile
and revalidate the downstream pin path.

## Type conversion rules

Use these only as planning hints; the schema response remains final.

| Source → target | Preset expectation |
|---|---|
| Exec → exec | Exact execution pins only; never convert. |
| Same category/subcategory/container | Usually direct, subject to reference/const/schema rules. |
| Wildcard → concrete | Let the owning node/schema promote the wildcard; verify all affected pins afterward. |
| Integer/real numeric families | Version- and node-dependent promotion/conversion; never hardcode a universal table. |
| Bool ↔ numeric | Do not assume an implicit conversion. Require an explicit node or schema conversion response. |
| Enum ↔ byte/integer | Prefer explicit enum conversion/selection nodes; require schema approval. |
| Child object → parent object | Often assignable; verify schema and interface/reference qualifiers. |
| Parent object → child object | Require an explicit/dynamic cast path unless the schema supplies one. |
| Object ↔ class reference | Different semantic types; do not connect without a schema-provided conversion. |
| Hard ↔ soft/weak object reference | Do not assume compatibility; use explicit load/convert APIs where appropriate. |
| Interface ↔ object | Use interface-aware cast/message rules; verify the exact pin types. |
| Struct → struct | Require the same struct or a registered specialized conversion. |
| Scalar ↔ array/set/map | No generic implicit conversion. Use make/get/loop/container nodes. |
| Container → container | Require compatible container kind and element/key/value types. |
| Delegate → delegate | Require compatible delegate signatures. |
| Pose → pose | Connect only within a compatible animation schema; poses are not generic K2 values. |

Also inspect `FEdGraphPinType` container type, subcategory object, reference,
const, weak-pointer and wrapper flags. Matching `PinCategory` alone is not proof
of compatibility.

## Default value rules

- Set defaults only on unconnected input pins.
- Call the current schema's `IsPinDefaultValid` before setting text defaults.
- Use `TrySetDefaultValue`, `TrySetDefaultObject`, or `TrySetDefaultText` for the
  correct storage kind; do not write `DefaultValue` fields blindly.
- Resolve object defaults with the exact engine/project asset path and class.
- Use Unreal's exported text format for structs, names and enums; validate it.
- After reconstructing a node, reapply only defaults that are still valid on
  the new pins.

## Function call rules

1. Resolve the exact owner class and `UFunction` in the matching engine build.
2. Require `FUNC_BlueprintCallable` or `FUNC_BlueprintPure` as appropriate.
3. Verify the function is valid in the destination graph/context; latent,
   protected, development-only, authority/cosmetic and world-context functions
   can impose additional rules.
4. Bind self-context only when the Blueprint class is compatible with the
   function owner. Otherwise expose/connect the target object pin.
5. Finalize/reconstruct, then inspect actual exec, parameter and return pins.
6. Match every required parameter by reflected property/pin type, not by a
   remembered signature.

## Animation Blueprint rules

- Preserve generated state/transition result nodes and their bound graphs.
- Require unique state, transition, cached-pose and graph names.
- Set sequence looping consistently with transition semantics.
- Use automatic remaining-time transitions only when the source state's player
  is the intended non-looping asset and the schema/compiler recognizes it.
- Treat BlendSpace axes and sample coordinates as asset-specific data; validate
  axis ranges before adding samples.
- Add separately modified BlendSpace/animation packages to the explicit save set.
- Recompile the Animation Blueprint after any structural graph edit.

## Validation checklist

Before `-Apply`, require validation to report:

- exact project, engine build, Editor target/module and commandlet class;
- primary Blueprint object path and graph/schema classes;
- every referenced class, function, property, animation and auxiliary asset;
- every node type to create/remove/reuse and its construction method;
- every pin connection with source/target names, directions and schema response;
- every allowed break-existing, conversion-node or promotion response;
- every default value and its schema validation result;
- every package that will be backed up and saved;
- expected node/transition/connection counts used for post-apply verification.

If any item cannot be resolved in validation mode, do not apply.

## Primary references

- [UEdGraphSchema API](https://dev.epicgames.com/documentation/en-us/unreal-engine/API/Runtime/Engine/UEdGraphSchema)
- [UEdGraphSchema_K2 API](https://dev.epicgames.com/documentation/unreal-engine/API/Editor/BlueprintGraph/UEdGraphSchema_K2)
- [BlueprintGraph API](https://dev.epicgames.com/documentation/en-us/unreal-engine/API/Editor/BlueprintGraph)
