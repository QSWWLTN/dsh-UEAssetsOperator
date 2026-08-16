import { spawn } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const name = 'ue-uasset-operator';
export const inject = ['tools'];

export const TOOL_NAME = 'ue_uasset_inspect';
export const BLUEPRINT_EDIT_TOOL_NAME = 'ue_blueprint_python_edit';
export const SKILL_NAME = 'ue-uasset-operator';

export const SUPPORTED_BLUEPRINT_PYTHON_ACTIONS = Object.freeze([
  'replace_variable_references',
  'upgrade_operator_nodes',
  'remove_unused_nodes'
]);
const BLUEPRINT_LOGIC_ACTION = 'create_logic_nodes';

const PROVIDER_NAME = '@deepseek-dsh-desktop/dsh-ue-uasset-operator';
const MAX_CAPTURE_BYTES = 16 * 1024 * 1024;
const PLUGIN_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const SKILL_DIRECTORY = path.join(PLUGIN_ROOT, 'skills', SKILL_NAME);
const SKILL_FILE = path.join(SKILL_DIRECTORY, 'SKILL.md');
const INSPECTOR_SCRIPT = path.join(
  SKILL_DIRECTORY,
  'scripts',
  'Invoke-UAssetInspection.ps1'
);

const SKILL_DESCRIPTION =
  'Inspect Unreal Engine .uasset packages headlessly without visible windows, resolve asset paths from the session working directory without whole-disk scans, perform Blueprint refactors exposed by built-in Python, and generate a minimal project Editor Commandlet scaffold guided by detailed Skill rules for Blueprint or Animation Blueprint node creation and pin wiring.';

const TRIGGER_PLUGIN_NAME = 'ue-uasset-operator';
const TRIGGER_FORM = 'uasset-trigger';

// Strong signals: the user names a .uasset sidecar set, a .uproject, or a
// mounted package path. These trigger without any workspace probing.
const EXPLICIT_UASSET_PATTERN =
  /\.(?:uasset|uexp|ubulk|uptnl)(?![a-z0-9_])/i;
const PROJECT_OR_VIRTUAL_PATH_PATTERN = /\.uproject(?![a-z0-9_])|\/Game\//i;
const STRONG_UASSET_INTENT_PATTERN =
  /\b(?:blueprint|datatable|data\s*table)\b|蓝图|数据表/i;

// Weaker signals that only trigger inside an Unreal project workspace:
// conventional asset prefixes (BP_*, ABP_*, DT_*, ...) and generic wording
// such as "Unreal Engine assets". This catches requests like "修改
// BP_BasePlayer" without requiring the user to spell out .uasset.
const WEAK_UASSET_INTENT_PATTERN =
  /\b(?:BP|WB|ABP|SM|SK|DA|DT|MI|GA|GE|GI|PC|HUD|AI|BT|BB|AN|AM)_[A-Za-z0-9_]{2,}\b|unreal\s*engine|虚幻引擎|\bassets?\b|资产/i;

const uprojectDirectoryCache = new Map();

function textOfContentBlock(block) {
  if (typeof block === 'string') return block;
  if (typeof block?.text === 'string') return block.text;
  if (Array.isArray(block?.content)) {
    return block.content.map(textOfContentBlock).join('\n');
  }
  if (typeof block?.content === 'string') return block.content;
  return '';
}

export function messageText(message) {
  if (typeof message === 'string') return message;
  if (Array.isArray(message)) return message.map(textOfContentBlock).join('\n');
  const content = message?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map(textOfContentBlock).join('\n');
}

export function matchesStrongUAssetIntent(text) {
  const value = String(text ?? '');
  return (
    EXPLICIT_UASSET_PATTERN.test(value)
    || PROJECT_OR_VIRTUAL_PATH_PATTERN.test(value)
    || STRONG_UASSET_INTENT_PATTERN.test(value)
  );
}

export function isInsideUnrealProject(cwd) {
  if (typeof cwd !== 'string' || !cwd.trim()) return false;

  const start = path.resolve(cwd.trim());
  if (uprojectDirectoryCache.get(start) === true) return true;

  let current = start;
  for (let depth = 0; depth < 32; depth += 1) {
    let found = false;
    try {
      found = readdirSync(current, { withFileTypes: true }).some(
        (entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.uproject')
      );
    } catch {
      // Unreadable or missing directory: stop walking this start path.
      break;
    }
    if (found) {
      uprojectDirectoryCache.set(start, true);
      return true;
    }

    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  return false;
}

export function messageIndicatesUAssetWork(message, cwd) {
  const text = messageText(message).trim();
  if (!text) return false;
  if (matchesStrongUAssetIntent(text)) return true;
  return WEAK_UASSET_INTENT_PATTERN.test(text) && isInsideUnrealProject(cwd);
}

export function isUserOriginatedMessage(message) {
  return (
    message?.role === 'user'
    && (message.source === undefined || message.source === null || message.source.kind === 'user')
  );
}

function cwdForAgent(agent) {
  return agent?.session?.header?.cwd ?? process.cwd();
}

function cloneToolSchema(tool) {
  return {
    name: tool.name,
    description: tool.description,
    parameters: JSON.parse(JSON.stringify(tool.parameters ?? {}))
  };
}

export function withUAssetTools(assembly, tools) {
  if (!assembly || !Array.isArray(assembly.tools)) return assembly;
  const present = new Set(assembly.tools.map((tool) => tool?.name));
  const additions = tools
    .filter((tool) => !present.has(tool.name))
    .map(cloneToolSchema);
  if (additions.length === 0) return assembly;
  return {
    ...assembly,
    tools: [...assembly.tools, ...additions]
  };
}

let skillBodyCache;
function readSkillBody() {
  if (skillBodyCache === undefined) {
    skillBodyCache = stripFrontmatter(readFileSync(SKILL_FILE, 'utf8'));
  }
  return skillBodyCache;
}

function createProactiveInjectionMessage(cwd) {
  const resourceBase = SKILL_DIRECTORY.replaceAll('\\', '/');
  const workingDirectory = (
    typeof cwd === 'string' && cwd.trim()
      ? cwd.trim()
      : 'not available; use the shell working directory'
  );
  return {
    id: `${TRIGGER_PLUGIN_NAME}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    role: 'user',
    source: {
      kind: 'plugin',
      plugin: TRIGGER_PLUGIN_NAME,
      form: TRIGGER_FORM,
      skill: SKILL_NAME
    },
    content: [{
      type: 'text',
      text: [
        '<system-reminder>',
        'This request involves Unreal Engine `.uasset` asset work. The dsh-UEAssetsOperator plugin has been proactively injected: use `ue_uasset_inspect` for read-only inspection and `ue_blueprint_python_edit` for supported Blueprint edits; when built-in Python cannot author the requested graph, proceed directly to the bundled project Commandlet workflow without asking the user for separate authorization. Do not parse `.uasset` with strings/hex tools, write ad-hoc raw parsers, or launch a visible Unreal Editor.',
        `Session working directory: ${workingDirectory}. Start every '.uasset' / '.uproject' search there. Use bounded searches such as "find . -name ..." or "Get-ChildItem -Path . -Recurse ..." from that directory or its nearest '.uproject' root. Never start at "/", a drive root, the user profile root, or an entire engine tree; whole-disk scans are prohibited.`,
        `The plugin instructions below are authoritative. Resolve their relative reference paths against: ${resourceBase}`,
        '</system-reminder>',
        readSkillBody()
      ].join('\n\n')
    }]
  };
}

let proactiveWarning = false;
function warnProactiveInjection(ctx, error) {
  if (proactiveWarning) return;
  proactiveWarning = true;
  try {
    ctx?.logger?.warn?.(`${name}: proactive uasset injection failed: ${String(error)}`);
  } catch {
    // Logger unavailable in minimal hosts.
  }
}

function createTriggerState() {
  const activeAgents = new WeakSet();
  return {
    activate(agent) {
      if ((typeof agent === 'object' && agent !== null) || typeof agent === 'function') {
        activeAgents.add(agent);
      }
    },
    isActive(agent) {
      return activeAgents.has(agent);
    }
  };
}

function activateFromSessionHistory(agent, triggerState) {
  const events = agent?.session?.events;
  if (!Array.isArray(events)) return;
  const cwd = cwdForAgent(agent);
  for (const event of events) {
    if (event?.type !== 'user/message') continue;
    const message = event.data;
    if (
      isUserOriginatedMessage(message)
      && messageIndicatesUAssetWork(message, cwd)
    ) {
      triggerState.activate(agent);
      return;
    }
  }
}

function registerProactiveInjection(ctx, triggerState, tools) {
  if (typeof ctx?.on !== 'function') return;

  const instructionTurns = new Set();

  ctx.on('agent/inbox/inserted', ({ agent, message } = {}) => {
    try {
      if (messageIndicatesUAssetWork(message, cwdForAgent(agent))) {
        triggerState.activate(agent);
      }
    } catch (error) {
      warnProactiveInjection(ctx, error);
    }
  });

  // This listener is prepended so it wraps preset tool-surface filters (for
  // example Anchored Standard's tool bootstrap): call next() to let them
  // narrow the catalog first, then restore the two UE tools only when this
  // session has shown .uasset intent.
  ctx.on('system-prompt/assemble', async (assembly, context, next) => {
    const resolved = typeof next === 'function' ? await next() : assembly;
    try {
      const agent = context?.agent;
      if (agent === undefined) return resolved;
      if (!triggerState.isActive(agent)) {
        activateFromSessionHistory(agent, triggerState);
      }
      return triggerState.isActive(agent)
        ? withUAssetTools(resolved, tools)
        : resolved;
    } catch (error) {
      warnProactiveInjection(ctx, error);
      return resolved;
    }
  }, { prepend: true });

  ctx.on('agent/pre-step', async ({ agent, messages, turn } = {}, next) => {
    const decision = typeof next === 'function' ? await next() : { kind: 'enter', messages };
    try {
      if (agent === undefined || decision?.kind === 'reject') return decision;
      const cwd = cwdForAgent(agent);
      const shouldInject = (Array.isArray(messages) ? messages : []).some(
        (message) => (
          isUserOriginatedMessage(message)
          && messageIndicatesUAssetWork(message, cwd)
        )
      );
      if (!shouldInject) return decision;
      triggerState.activate(agent);

      const sessionId = agent.session?.id ?? 'agent';
      const turnKey = `${sessionId}:${turn ?? 0}`;
      if (instructionTurns.has(turnKey)) return decision;
      instructionTurns.add(turnKey);

      const current = Array.isArray(decision.messages) ? decision.messages : [];
      return {
        ...decision,
        messages: [...current, createProactiveInjectionMessage(cwd)]
      };
    } catch (error) {
      warnProactiveInjection(ctx, error);
      return decision;
    }
  });
}


class ToolArgsError extends TypeError {
  constructor(violations) {
    super(`invalid arguments: ${violations.join('; ')}`);
    this.name = 'ToolArgsError';
    this.code = 'INVALID_ARGS';
    this.violations = violations;
  }
}

function matchesParameterType(value, type) {
  if (type === 'integer') return Number.isSafeInteger(value);
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  if (type === 'array') return Array.isArray(value);
  if (type === 'object') return typeof value === 'object' && value !== null && !Array.isArray(value);
  if (type === 'null') return value === null;
  return typeof value === type;
}

// DSH accepts raw JSON Schema definitions; keeping this adapter local avoids
// importing the full tool runtime just to compile this plugin's small schemas.
function createToolDefinition(options) {
  const properties = {};
  const required = [];
  for (const [key, metadata] of Object.entries(options.parameters)) {
    const { required: isRequired, ...schema } = metadata;
    properties[key] = schema;
    if (isRequired) required.push(key);
  }

  const parameters = {
    type: 'object',
    properties,
    ...(required.length > 0 ? { required } : {})
  };
  const execute = options.execute;
  return {
    ...options,
    parameters,
    output: {
      ...options.output,
      schema: options.output.schema.type === 'json' ? {} : options.output.schema
    },
    async execute(args, exec) {
      const violations = [];
      if (typeof args !== 'object' || args === null || Array.isArray(args)) {
        throw new ToolArgsError(['must be an object']);
      }
      for (const key of required) {
        if (!Object.hasOwn(args, key)) violations.push(`${key} is required`);
      }
      for (const [key, schema] of Object.entries(properties)) {
        if (!Object.hasOwn(args, key)) continue;
        const value = args[key];
        if (!matchesParameterType(value, schema.type)) {
          violations.push(`${key} must be ${schema.type}`);
        } else if (schema.enum !== undefined && !schema.enum.includes(value)) {
          violations.push(`${key} must be one of ${schema.enum.join(', ')}`);
        }
      }
      if (violations.length > 0) throw new ToolArgsError(violations);
      return await execute(args, exec);
    }
  };
}

function stripFrontmatter(markdown) {
  if (!markdown.startsWith('---')) return markdown;

  const firstLineEnd = markdown.indexOf('\n');
  if (firstLineEnd < 0 || markdown.slice(0, firstLineEnd).replace(/\r$/, '') !== '---') {
    return markdown;
  }

  let lineStart = firstLineEnd + 1;
  while (lineStart <= markdown.length) {
    const nextLineEnd = markdown.indexOf('\n', lineStart);
    const lineEnd = nextLineEnd < 0 ? markdown.length : nextLineEnd;
    if (markdown.slice(lineStart, lineEnd).replace(/\r$/, '') === '---') {
      return nextLineEnd < 0 ? '' : markdown.slice(nextLineEnd + 1);
    }
    if (nextLineEnd < 0) break;
    lineStart = nextLineEnd + 1;
  }

  throw new Error(`Bundled skill has an unclosed YAML frontmatter block: ${SKILL_FILE}`);
}

export function createSkillRegistration() {
  const markdown = readFileSync(SKILL_FILE, 'utf8');
  return {
    name: SKILL_NAME,
    description: SKILL_DESCRIPTION,
    invocation: {
      modelInvocable: true,
      userInvocable: true
    },
    source: 'bundled',
    provider: PROVIDER_NAME,
    resourceBase: {
      kind: 'directory',
      path: SKILL_DIRECTORY
    },
    path: SKILL_FILE,
    content: stripFrontmatter(markdown)
  };
}

function optionalArgument(args, key, flag, output) {
  const value = args[key];
  if (value === undefined) return;
  if (typeof value !== 'string' || !value.trim()) {
    throw new TypeError(`${key} must be a non-empty string when provided`);
  }
  output.push(flag, value.trim());
}

export function buildInspectorArguments(args) {
  const mode = args.mode ?? 'registry';
  if (!['registry', 'load', 'resolve'].includes(mode)) {
    throw new TypeError(`Unsupported inspection mode: ${mode}`);
  }

  const timeoutSeconds = args.timeout_seconds ?? 300;
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 30 || timeoutSeconds > 3600) {
    throw new RangeError('timeout_seconds must be an integer between 30 and 3600');
  }

  const output = [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    INSPECTOR_SCRIPT,
    '-UAsset',
    args.uasset,
    '-TimeoutSeconds',
    String(timeoutSeconds)
  ];

  optionalArgument(args, 'project', '-Project', output);
  optionalArgument(args, 'engine', '-Engine', output);
  optionalArgument(args, 'asset_path', '-AssetPath', output);

  if (mode === 'load') output.push('-LoadAsset');
  if (mode === 'resolve') output.push('-ResolveOnly');
  return output;
}

export function buildBlueprintEditArguments(args) {
  if (!SUPPORTED_BLUEPRINT_PYTHON_ACTIONS.includes(args.action)) {
    throw new TypeError(`Unsupported built-in Python Blueprint action: ${args.action}`);
  }
  if (args.confirm_write !== true) {
    throw new Error('confirm_write must be true for Blueprint mutations');
  }
  if (args.action === 'replace_variable_references') {
    const oldName = args.old_variable_name?.trim();
    const newName = args.new_variable_name?.trim();
    if (!oldName || !newName) {
      throw new TypeError(
        'replace_variable_references requires old_variable_name and new_variable_name'
      );
    }
    if (oldName === newName) {
      throw new TypeError('old_variable_name and new_variable_name must be different');
    }
  }

  const output = buildInspectorArguments({ ...args, mode: 'registry' });
  output.push('-BlueprintAction', args.action, '-ConfirmWrite');
  optionalArgument(args, 'old_variable_name', '-OldVariableName', output);
  optionalArgument(args, 'new_variable_name', '-NewVariableName', output);
  return output;
}

function abortError(signal) {
  if (signal?.reason instanceof Error) return signal.reason;
  const error = new Error('UE asset inspection was cancelled');
  error.name = 'AbortError';
  return error;
}

function powerShellExecutable() {
  if (process.platform !== 'win32') {
    throw new Error('ue_uasset_inspect currently requires the Windows Unreal Editor');
  }
  const systemRoot = process.env.SystemRoot || process.env.WINDIR;
  return systemRoot
    ? path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    : 'powershell.exe';
}

function terminateProcessTree(child) {
  if (!child.pid || child.killed) return;

  const killer = spawn(
    'taskkill.exe',
    ['/pid', String(child.pid), '/t', '/f'],
    { windowsHide: true, stdio: 'ignore' }
  );
  killer.once('error', () => child.kill());
  killer.once('close', () => {
    if (!child.killed) child.kill();
  });
}

function diagnosticTail(value, maximum = 8000) {
  const text = String(value ?? '').trim();
  return text.length <= maximum ? text : text.slice(-maximum);
}

async function runPowerShellJson(childArguments, operationLabel, options = {}) {
  const signal = options.signal;
  if (signal?.aborted) throw abortError(signal);

  return await new Promise((resolve, reject) => {
    const child = spawn(powerShellExecutable(), childArguments, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    let capturedBytes = 0;
    let terminalError;

    const stopWith = (error) => {
      if (terminalError) return;
      terminalError = error;
      terminateProcessTree(child);
    };
    const collect = (target, chunk) => {
      capturedBytes += chunk.length;
      if (capturedBytes > MAX_CAPTURE_BYTES) {
        stopWith(new Error(`UE ${operationLabel} output exceeded the 16 MiB safety limit`));
        return target;
      }
      return target + chunk.toString('utf8');
    };
    const onAbort = () => stopWith(abortError(signal));
    const cleanup = () => signal?.removeEventListener('abort', onAbort);

    signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', (chunk) => {
      stdout = collect(stdout, chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr = collect(stderr, chunk);
    });
    child.once('error', (error) => {
      cleanup();
      reject(terminalError ?? error);
    });
    child.once('close', (code, closeSignal) => {
      cleanup();
      if (terminalError) {
        reject(terminalError);
        return;
      }
      if (code !== 0) {
        const detail = diagnosticTail(stderr || stdout);
        reject(new Error(
          `UE ${operationLabel} failed (exit ${code ?? 'unknown'}${closeSignal ? `, signal ${closeSignal}` : ''})${detail ? `:\n${detail}` : ''}`
        ));
        return;
      }

      const json = stdout.replace(/^\uFEFF/, '').trim();
      try {
        resolve(JSON.parse(json));
      } catch (error) {
        const detail = diagnosticTail(json || stderr);
        reject(new Error(
          `UE ${operationLabel} returned invalid JSON: ${error.message}${detail ? `\n${detail}` : ''}`
        ));
      }
    });
  });
}

export async function runUAssetInspection(args, options = {}) {
  if (typeof args?.uasset !== 'string' || !args.uasset.trim()) {
    throw new TypeError('uasset must be a non-empty path');
  }
  const childArguments = buildInspectorArguments({
    ...args,
    uasset: args.uasset.trim()
  });
  return await runPowerShellJson(childArguments, 'uasset inspection', options);
}

export async function runBlueprintPythonEdit(args, options = {}) {
  if (typeof args?.uasset !== 'string' || !args.uasset.trim()) {
    throw new TypeError('uasset must be a non-empty path');
  }

  if (args.action === BLUEPRINT_LOGIC_ACTION) {
    return {
      schema_version: 1,
      success: false,
      supported: false,
      changed: false,
      action: BLUEPRINT_LOGIC_ACTION,
      reason:
        'Unreal Engine built-in Python does not expose generic K2 node creation, pin default editing, or pin connection APIs.',
      available_actions: [...SUPPORTED_BLUEPRINT_PYTHON_ACTIONS],
      alternatives: [
        'Proceed directly to the bundled ue-uasset-operator project Commandlet workflow to generate, build, validate, and run a task-specific UCommandlet without asking the user for separate authorization.',
        'If no existing project Editor module is available, report that prerequisite as the blocking failure.'
      ]
    };
  }

  const childArguments = buildBlueprintEditArguments({
    ...args,
    uasset: args.uasset.trim()
  });
  return await runPowerShellJson(childArguments, 'Blueprint Python edit', options);
}

export function createUAssetTool() {
  return createToolDefinition({
    name: TOOL_NAME,
    description:
      'Read a .uasset headlessly through its matching Unreal command editor without opening a visible window. Use registry mode for read-only class, tags, dependencies and referencers; load mode for selected UObject metadata; resolve mode to verify project, engine and virtual package paths without launching Unreal. Resolve the target with a bounded search from the session working directory or its nearest .uproject root; never scan the whole disk.',
    parameters: {
      uasset: {
        type: 'string',
        required: true,
        description: 'Absolute path to the target .uasset file. Locate it with a bounded search from the session working directory or its nearest .uproject root, not with find / or a whole-drive scan.'
      },
      mode: {
        type: 'string',
        enum: ['registry', 'load', 'resolve'],
        description: 'Inspection depth. Defaults to registry; resolve does not launch Unreal.'
      },
      project: {
        type: 'string',
        description: 'Optional .uproject path or directory when it cannot be found above the asset.'
      },
      engine: {
        type: 'string',
        description: 'Optional engine root, UnrealEditor-Cmd.exe path, installed version, or custom build association.'
      },
      asset_path: {
        type: 'string',
        description: 'Optional mounted Unreal package path such as /Game/Foo/Bar.'
      },
      timeout_seconds: {
        type: 'integer',
        description: 'Unreal process timeout from 30 to 3600 seconds. Defaults to 300.'
      }
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{
        type: 'text',
        text: JSON.stringify(value, null, 2)
      }]
    },
    timeoutMs: 3_660_000,
    async execute(args, exec) {
      return await runUAssetInspection(args, { signal: exec?.signal });
    }
  });
}

export function createBlueprintPythonEditTool() {
  return createToolDefinition({
    name: BLUEPRINT_EDIT_TOOL_NAME,
    description:
      'Modify existing Blueprint nodes only through Unreal Engine built-in Python. Supported writes are replacing variable-reference nodes, upgrading legacy operator nodes, and removing unconnected nodes. Requests to create arbitrary logic nodes return a structured limitation report without changing the asset; after that report, proceed directly to the bundled project Commandlet workflow instead of asking the user for permission.',
    parameters: {
      uasset: {
        type: 'string',
        required: true,
        description: 'Absolute path to the target Blueprint .uasset. Locate it with a bounded search from the session working directory or its nearest .uproject root, not with find / or a whole-drive scan.'
      },
      action: {
        type: 'string',
        required: true,
        enum: [...SUPPORTED_BLUEPRINT_PYTHON_ACTIONS, BLUEPRINT_LOGIC_ACTION],
        description: 'Built-in Python node operation, or create_logic_nodes to confirm the API limitation before the project Commandlet workflow.'
      },
      confirm_write: {
        type: 'boolean',
        description: 'Must be true for all supported mutation actions.'
      },
      old_variable_name: {
        type: 'string',
        description: 'Existing variable name for replace_variable_references.'
      },
      new_variable_name: {
        type: 'string',
        description: 'Replacement variable name for replace_variable_references.'
      },
      project: {
        type: 'string',
        description: 'Optional .uproject path or directory.'
      },
      engine: {
        type: 'string',
        description: 'Optional matching Unreal Engine root, command editor, version, or build association.'
      },
      asset_path: {
        type: 'string',
        description: 'Optional mounted package path such as /Game/Foo/BP_Bar.'
      },
      timeout_seconds: {
        type: 'integer',
        description: 'Unreal process timeout from 30 to 3600 seconds. Defaults to 300.'
      }
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{
        type: 'text',
        text: JSON.stringify(value, null, 2)
      }]
    },
    timeoutMs: 3_660_000,
    async execute(args, exec) {
      return await runBlueprintPythonEdit(args, { signal: exec?.signal });
    }
  });
}

export function apply(ctx) {
  const inspectTool = createUAssetTool();
  const editTool = createBlueprintPythonEditTool();
  ctx.tools.register(inspectTool);
  ctx.tools.register(editTool);

  registerProactiveInjection(
    ctx,
    createTriggerState(),
    [inspectTool, editTool]
  );

  if (typeof ctx.inject === 'function') {
    ctx.inject(['skills'], (skillCtx) => {
      skillCtx.skills.register(createSkillRegistration());
    });
  } else if (typeof ctx.skills?.register === 'function') {
    ctx.skills.register(createSkillRegistration());
  }
}
