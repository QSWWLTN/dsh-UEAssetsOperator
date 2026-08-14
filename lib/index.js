import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineTool } from '@deepseek-ai/dsh-tools';

export const name = 'ue-uasset-operator';
export const inject = ['skills', 'tools'];

export const TOOL_NAME = 'ue_uasset_inspect';
export const SKILL_NAME = 'ue-uasset-operator';

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
  'Inspect Unreal Engine .uasset packages through the matching Unreal Editor, read Asset Registry metadata, dependencies, referencers, sidecars, and optionally loaded UObject details, while keeping the operation read-only.';

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

export async function runUAssetInspection(args, options = {}) {
  if (typeof args?.uasset !== 'string' || !args.uasset.trim()) {
    throw new TypeError('uasset must be a non-empty path');
  }

  const signal = options.signal;
  if (signal?.aborted) throw abortError(signal);

  const childArguments = buildInspectorArguments({
    ...args,
    uasset: args.uasset.trim()
  });

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
        stopWith(new Error('UE inspection output exceeded the 16 MiB safety limit'));
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
          `UE uasset inspection failed (exit ${code ?? 'unknown'}${closeSignal ? `, signal ${closeSignal}` : ''})${detail ? `:\n${detail}` : ''}`
        ));
        return;
      }

      const json = stdout.replace(/^\uFEFF/, '').trim();
      try {
        resolve(JSON.parse(json));
      } catch (error) {
        const detail = diagnosticTail(json || stderr);
        reject(new Error(
          `UE uasset inspector returned invalid JSON: ${error.message}${detail ? `\n${detail}` : ''}`
        ));
      }
    });
  });
}

export function createUAssetTool() {
  return defineTool({
    name: TOOL_NAME,
    description:
      'Read a .uasset through its matching Unreal Editor. Use registry mode for read-only class, tags, dependencies and referencers; load mode for selected UObject metadata; resolve mode to verify project, engine and virtual package paths without launching Unreal.',
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
      return await runUAssetInspection(args, { signal: exec.signal });
    }
  });
}

export function apply(ctx) {
  ctx.skills.register(createSkillRegistration());
  ctx.tools.register(createUAssetTool());
}
