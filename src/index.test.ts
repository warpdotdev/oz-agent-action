import { beforeEach, describe, expect, it, vi } from 'vitest'

const coreState = new Map<string, string>()
const coreInputs = new Map<string, string>()
const coreOutputs = new Map<string, string>()

const coreMocks = vi.hoisted(() => ({
  getInput: vi.fn(),
  getBooleanInput: vi.fn(),
  getMultilineInput: vi.fn(),
  saveState: vi.fn(),
  getState: vi.fn(),
  setOutput: vi.fn(),
  setFailed: vi.fn(),
  info: vi.fn(),
  warning: vi.fn(),
  debug: vi.fn(),
  isDebug: vi.fn(),
  group: vi.fn()
}))

const execMocks = vi.hoisted(() => ({
  getExecOutput: vi.fn(),
  exec: vi.fn()
}))

const toolCacheMocks = vi.hoisted(() => ({
  find: vi.fn(),
  downloadTool: vi.fn(),
  cacheFile: vi.fn()
}))

vi.mock('@actions/core', () => coreMocks)
vi.mock('@actions/exec', () => execMocks)
vi.mock('@actions/tool-cache', () => toolCacheMocks)
vi.mock('@actions/http-client', () => ({
  HttpClient: vi.fn()
}))

const index = await import('./index')

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', {
    value: platform
  })
}

function setArch(arch: NodeJS.Architecture): void {
  Object.defineProperty(process, 'arch', {
    value: arch
  })
}

function setDefaultInputs(): void {
  coreInputs.set('oz_channel', 'stable')
  coreInputs.set('prompt', 'Say hello')
  coreInputs.set('saved_prompt', '')
  coreInputs.set('skill', '')
  coreInputs.set('model', '')
  coreInputs.set('name', '')
  coreInputs.set('mcp', '')
  coreInputs.set('cwd', '')
  coreInputs.set('profile', '')
  coreInputs.set('output_format', 'text')
  coreInputs.set('warp_api_key', 'test-api-key')
  coreInputs.set('oz_version', 'latest')
  coreInputs.set('cloud', 'false')
}

beforeEach(() => {
  vi.clearAllMocks()
  coreState.clear()
  coreInputs.clear()
  coreOutputs.clear()
  setDefaultInputs()
  setPlatform('linux')
  setArch('x64')

  coreMocks.getInput.mockImplementation((name: string) => coreInputs.get(name) ?? '')
  coreMocks.getBooleanInput.mockImplementation((name: string) => coreInputs.get(name) === 'true')
  coreMocks.getMultilineInput.mockImplementation(() => [])
  coreMocks.saveState.mockImplementation((name: string, value: string) => {
    coreState.set(name, value)
  })
  coreMocks.getState.mockImplementation((name: string) => coreState.get(name) ?? '')
  coreMocks.setOutput.mockImplementation((name: string, value: string) => {
    coreOutputs.set(name, value)
  })
  coreMocks.group.mockImplementation(async (_name: string, fn: () => Promise<unknown>) => fn())
  coreMocks.isDebug.mockReturnValue(false)

  execMocks.exec.mockResolvedValue(0)
  toolCacheMocks.find.mockReturnValue('/tmp/oz-cache')
})

describe('parseRunIdFromOutput', () => {
  it('parses text output', () => {
    expect(index.parseRunIdFromOutput('Run ID: run-123\nOpen in Oz: https://example')).toBe(
      'run-123'
    )
  })

  it('parses JSONL run_started output', () => {
    const output = [
      'not json',
      JSON.stringify({
        type: 'system',
        event_type: 'run_started',
        run_id: 'run-json'
      })
    ].join('\n')

    expect(index.parseRunIdFromOutput(output)).toBe('run-json')
  })

  it('ignores unrelated output', () => {
    expect(index.parseRunIdFromOutput('hello\n{"type":"agent","text":"done"}')).toBeUndefined()
  })
})

describe('buildReportShutdownArgs', () => {
  it('builds clean shutdown args for exit code 0', () => {
    expect(index.buildReportShutdownArgs('run-1', '0')).toEqual([
      'harness-support',
      '--run-id',
      'run-1',
      'report-shutdown'
    ])
  })

  it('builds process exit args for non-zero exit code', () => {
    expect(index.buildReportShutdownArgs('run-1', '17')).toEqual([
      'harness-support',
      '--run-id',
      'run-1',
      'report-shutdown',
      '--error-category',
      'process_exit',
      '--error-message',
      'agent exited with status 17'
    ])
  })

  it('builds interrupted action args when no exit code was saved', () => {
    expect(index.buildReportShutdownArgs('run-1', '')).toEqual([
      'harness-support',
      '--run-id',
      'run-1',
      'report-shutdown',
      '--error-category',
      'process_exit',
      '--error-message',
      'agent action ended before recording an exit code'
    ])
  })
})

describe('runAgent', () => {
  it('saves the run ID from streaming stdout before the process exits', async () => {
    execMocks.getExecOutput.mockImplementation(async (_command, _args, options) => {
      options.listeners.stdout(Buffer.from('Run ID: streamed-run\n'))
      return {
        exitCode: 0,
        stdout: 'Run ID: streamed-run\nAgent output\n',
        stderr: ''
      }
    })

    await index.runAgent({ skipInstall: true })

    expect(coreMocks.saveState).toHaveBeenCalledWith(index.RUN_ID_STATE, 'streamed-run')
    expect(coreState.get(index.EXIT_CODE_STATE)).toBe('0')
    expect(coreOutputs.get('agent_output')).toBe('Run ID: streamed-run\nAgent output\n')
  })

  it('records the exit code and throws when the agent exits non-zero', async () => {
    execMocks.getExecOutput.mockImplementation(async (_command, _args, options) => {
      options.listeners.stdout(Buffer.from('Run ID: failed-run\n'))
      return {
        exitCode: 9,
        stdout: 'Run ID: failed-run\n',
        stderr: ''
      }
    })

    await expect(index.runAgent({ skipInstall: true })).rejects.toThrow(
      "The process 'oz' failed with exit code 9"
    )

    expect(coreState.get(index.RUN_ID_STATE)).toBe('failed-run')
    expect(coreState.get(index.EXIT_CODE_STATE)).toBe('9')
    expect(coreMocks.setOutput).not.toHaveBeenCalled()
  })

  it('uses run-cloud subcommand when cloud is true', async () => {
    coreInputs.set('cloud', 'true')
    execMocks.getExecOutput.mockResolvedValue({
      exitCode: 0,
      stdout: 'Run ID: cloud-run\n',
      stderr: ''
    })

    await index.runAgent({ skipInstall: true })

    expect(execMocks.getExecOutput).toHaveBeenCalledWith(
      'oz',
      expect.arrayContaining(['agent', 'run-cloud']),
      expect.anything()
    )
    const callArgs = execMocks.getExecOutput.mock.calls[0][1] as string[]
    expect(callArgs).not.toContain('run')
    expect(callArgs).not.toContain('--sandboxed')
  })

  it('uses run subcommand and adds --sandboxed when cloud is false', async () => {
    execMocks.getExecOutput.mockResolvedValue({
      exitCode: 0,
      stdout: 'Run ID: local-run\n',
      stderr: ''
    })

    await index.runAgent({ skipInstall: true })

    expect(execMocks.getExecOutput).toHaveBeenCalledWith(
      'oz',
      expect.arrayContaining(['agent', 'run', '--sandboxed']),
      expect.anything()
    )
    const callArgs = execMocks.getExecOutput.mock.calls[0][1] as string[]
    expect(callArgs).not.toContain('run-cloud')
  })

  it('omits run-only flags (--cwd, --profile, --share) for cloud runs even when set', async () => {
    coreInputs.set('cloud', 'true')
    coreInputs.set('cwd', './repo')
    coreInputs.set('profile', 'ci-profile')
    coreMocks.getMultilineInput.mockReturnValue(['teammate@warp.dev'])
    execMocks.getExecOutput.mockResolvedValue({
      exitCode: 0,
      stdout: 'Run ID: cloud-run\n',
      stderr: ''
    })

    await index.runAgent({ skipInstall: true })

    const callArgs = execMocks.getExecOutput.mock.calls[0][1] as string[]
    expect(callArgs).toEqual(expect.arrayContaining(['agent', 'run-cloud']))
    expect(callArgs).not.toContain('--cwd')
    expect(callArgs).not.toContain('--profile')
    expect(callArgs).not.toContain('--share')
    expect(callArgs).not.toContain('--sandboxed')
    expect(coreMocks.warning).toHaveBeenCalledWith(
      expect.stringContaining('`cwd` is not supported for cloud agent runs')
    )
    expect(coreMocks.warning).toHaveBeenCalledWith(
      expect.stringContaining('`profile` is not supported for cloud agent runs')
    )
    expect(coreMocks.warning).toHaveBeenCalledWith(
      expect.stringContaining('`share` is not supported for cloud agent runs')
    )
  })

  it('passes run-only flags and skips --sandboxed when a profile is set for non-cloud runs', async () => {
    coreInputs.set('cwd', './repo')
    coreInputs.set('profile', 'ci-profile')
    coreMocks.getMultilineInput.mockReturnValue(['teammate@warp.dev'])
    execMocks.getExecOutput.mockResolvedValue({
      exitCode: 0,
      stdout: 'Run ID: local-run\n',
      stderr: ''
    })

    await index.runAgent({ skipInstall: true })

    const callArgs = execMocks.getExecOutput.mock.calls[0][1] as string[]
    expect(callArgs).toEqual(expect.arrayContaining(['agent', 'run']))
    expect(callArgs).not.toContain('run-cloud')
    expect(callArgs).toEqual(
      expect.arrayContaining([
        '--cwd',
        './repo',
        '--profile',
        'ci-profile',
        '--share',
        'teammate@warp.dev'
      ])
    )
    // A profile already configures the sandbox, so --sandboxed is omitted.
    expect(callArgs).not.toContain('--sandboxed')
    expect(coreMocks.warning).not.toHaveBeenCalled()
  })
})

describe('reportShutdown', () => {
  it('skips when no run ID was saved', async () => {
    await index.reportShutdown()

    expect(execMocks.getExecOutput).not.toHaveBeenCalled()
    expect(coreMocks.info).toHaveBeenCalledWith(
      'No Oz run ID was captured; skipping shutdown report.'
    )
  })

  it('reports clean shutdown for a saved successful run', async () => {
    coreState.set(index.RUN_ID_STATE, 'run-clean')
    coreState.set(index.EXIT_CODE_STATE, '0')
    coreInputs.set('oz_channel', 'preview')
    execMocks.getExecOutput.mockResolvedValue({
      exitCode: 0,
      stdout: '',
      stderr: ''
    })

    await index.reportShutdown()

    expect(execMocks.getExecOutput).toHaveBeenCalledWith(
      'oz-preview',
      ['harness-support', '--run-id', 'run-clean', 'report-shutdown'],
      expect.objectContaining({
        ignoreReturnCode: true
      })
    )
    expect(coreMocks.info).toHaveBeenCalledWith('Reported shutdown for run-clean')
  })

  it('reports abnormal shutdown when a run ID exists but no exit code was saved', async () => {
    coreState.set(index.RUN_ID_STATE, 'run-cancelled')
    execMocks.getExecOutput.mockResolvedValue({
      exitCode: 0,
      stdout: '',
      stderr: ''
    })

    await index.reportShutdown()

    expect(execMocks.getExecOutput).toHaveBeenCalledWith(
      'oz',
      [
        'harness-support',
        '--run-id',
        'run-cancelled',
        'report-shutdown',
        '--error-category',
        'process_exit',
        '--error-message',
        'agent action ended before recording an exit code'
      ],
      expect.objectContaining({
        ignoreReturnCode: true
      })
    )
  })

  it('warns but does not throw when report-shutdown fails', async () => {
    coreState.set(index.RUN_ID_STATE, 'run-warning')
    coreState.set(index.EXIT_CODE_STATE, '0')
    execMocks.getExecOutput.mockResolvedValue({
      exitCode: 1,
      stdout: '',
      stderr: 'failed'
    })

    await index.reportShutdown()

    expect(coreMocks.warning).toHaveBeenCalledWith('Error reporting shutdown for run-warning')
  })
})
