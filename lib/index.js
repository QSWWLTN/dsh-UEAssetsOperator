import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
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
  'Inspect Unreal Engine .uasset packages headlessly without visible windows, perform Blueprint refactors exposed by built-in Python, and generate a minimal project Editor Commandlet scaffold guided by detailed Skill rules for authorized Blueprint or Animation Blueprint node creation and pin wiring.';

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
        'Ask for a Blueprint node-by-node construction plan and apply it manually in the Blueprint Editor.',
        'Authorize a dedicated Unreal Editor C++ extension if fully automated arbitrary graph editing becomes acceptable.'
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
      'Read a .uasset headlessly through its matching Unreal command editor without opening a visible window. Use registry mode for read-only class, tags, dependencies and referencers; load mode for selected UObject metadata; resolve mode to verify project, engine and virtual package paths without launching Unreal.',
    parameters: {
      uasset: {
        type: 'string',
        required: true,
        description: 'Absolute path to the target .uasset file.'
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
      'Modify existing Blueprint nodes only through Unreal Engine built-in Python. Supported writes are replacing variable-reference nodes, upgrading legacy operator nodes, and removing unconnected nodes. Requests to create arbitrary logic nodes return a structured unsupported explanation without changing the asset.',
    parameters: {
      uasset: {
        type: 'string',
        required: true,
        description: 'Absolute path to the target Blueprint .uasset.'
      },
      action: {
        type: 'string',
        required: true,
        enum: [...SUPPORTED_BLUEPRINT_PYTHON_ACTIONS, BLUEPRINT_LOGIC_ACTION],
        description: 'Built-in Python node operation, or create_logic_nodes to report the API limitation.'
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
  ctx.tools.register(createUAssetTool());
  ctx.tools.register(createBlueprintPythonEditTool());

  if (typeof ctx.inject === 'function') {
    ctx.inject(['skills'], (skillCtx) => {
      skillCtx.skills.register(createSkillRegistration());
    });
  } else if (typeof ctx.skills?.register === 'function') {
    ctx.skills.register(createSkillRegistration());
  }
}
