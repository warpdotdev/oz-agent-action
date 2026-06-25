import * as process from 'process'
import * as path from 'path'
import * as fs from 'fs'
import * as os from 'os'

import * as core from '@actions/core'
import * as exec from '@actions/exec'
import * as tc from '@actions/tool-cache'
import * as http from '@actions/http-client'

export const MAIN_STARTED_STATE = 'oz_action_main_started'
export const RUN_ID_STATE = 'oz_action_run_id'
export const EXIT_CODE_STATE = 'oz_action_exit_code'

const RUN_ID_TEXT_PATTERN = /^Run ID:\s*(\S+)\s*$/m

function commandForChannel(channel: string): string {
  switch (channel) {
    case 'stable':
      return 'oz'
    case 'preview':
      return 'oz-preview'
    default:
      throw new Error(`Unsupported channel ${channel}`)
  }
}

export function parseRunIdFromOutput(output: string): string | undefined {
  const textMatch = RUN_ID_TEXT_PATTERN.exec(output)
  if (textMatch?.[1]) {
    return textMatch[1]
  }

  for (const line of output.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) {
      continue
    }

    try {
      const message = JSON.parse(trimmed) as {
        type?: unknown
        event_type?: unknown
        run_id?: unknown
      }
      if (
        message.type === 'system' &&
        message.event_type === 'run_started' &&
        typeof message.run_id === 'string' &&
        message.run_id
      ) {
        return message.run_id
      }
    } catch {
      // Ignore non-JSON output lines.
    }
  }

  return undefined
}

export function buildReportShutdownArgs(runId: string, exitCodeState: string): string[] {
  const args = ['harness-support', '--run-id', runId, 'report-shutdown']
  const trimmedExitCode = exitCodeState.trim()

  if (trimmedExitCode === '0') {
    return args
  }

  if (trimmedExitCode) {
    args.push('--error-category', 'process_exit')
    args.push('--error-message', `agent exited with status ${trimmedExitCode}`)
    return args
  }

  args.push('--error-category', 'process_exit')
  args.push('--error-message', 'agent action ended before recording an exit code')
  return args
}

interface RunAgentOptions {
  skipInstall?: boolean
}

// Run Oz agent.
export async function runAgent(options: RunAgentOptions = {}): Promise<void> {
  core.saveState(MAIN_STARTED_STATE, 'true')
  const channel = core.getInput('oz_channel')
  const prompt = core.getInput('prompt')
  const savedPrompt = core.getInput('saved_prompt')
  const skill = core.getInput('skill')

  const model = core.getInput('model')
  const name = core.getInput('name')
  const mcp = core.getInput('mcp')

  if (!prompt && !savedPrompt && !skill) {
    throw new Error('Either `prompt`, `saved_prompt`, or `skill` must be provided')
  }

  const apiKey = core.getInput('warp_api_key')
  if (!apiKey) {
    throw new Error('`warp_api_key` must be provided.')
  }

  const command = commandForChannel(channel)

  if (!options.skipInstall) {
    await installOz(channel, core.getInput('oz_version'))
  }

  const cloud = core.getBooleanInput('cloud')
  const args = ['agent', cloud ? 'run-cloud' : 'run']
  const host = core.getInput('host')
  if (host) {
    if (cloud) {
      args.push('--host', host)
    } else {
      core.warning(
        '`host` is not supported for local agent runs (`oz agent run`) and will be ignored.'
      )
    }
  }

  if (prompt) {
    args.push('--prompt', prompt)
  }

  if (savedPrompt) {
    args.push('--saved-prompt', savedPrompt)
  }

  if (skill) {
    args.push('--skill', skill)
  }

  if (model) {
    args.push('--model', model)
  }

  if (name) {
    args.push('--name', name)
  }

  if (mcp) {
    args.push('--mcp', mcp)
  }

  // `--cwd`, `--profile`, and `--share` are only accepted by `oz agent run`.
  // `oz agent run-cloud` rejects them as unexpected arguments, so gate them on
  // `!cloud` and warn when a caller sets one for a cloud run so the dropped
  // input is discoverable instead of silently ignored.
  const cwd = core.getInput('cwd')
  if (cwd) {
    if (cloud) {
      core.warning(
        '`cwd` is not supported for cloud agent runs (`oz agent run-cloud`) and will be ignored.'
      )
    } else {
      args.push('--cwd', cwd)
    }
  }

  const profile = core.getInput('profile')
  if (profile) {
    if (cloud) {
      core.warning(
        '`profile` is not supported for cloud agent runs (`oz agent run-cloud`) and will be ignored.'
      )
    } else {
      args.push('--profile', profile)
    }
  } else if (!cloud) {
    args.push('--sandboxed')
  }

  const outputFormat = core.getInput('output_format')
  if (outputFormat) {
    args.push('--output-format', outputFormat)
  }

  const shareRecipients = core.getMultilineInput('share')
  if (shareRecipients.length > 0) {
    if (cloud) {
      core.warning(
        '`share` is not supported for cloud agent runs (`oz agent run-cloud`) and will be ignored.'
      )
    } else {
      for (const recipient of shareRecipients) {
        args.push('--share', recipient)
      }
    }
  }

  // In debug mode, show Oz logs on stderr.
  if (core.isDebug()) {
    args.push('--debug')
  }

  let stdout = ''
  let savedRunId: string | undefined
  let execResult
  try {
    execResult = await exec.getExecOutput(command, args, {
      env: {
        ...process.env,
        WARP_API_KEY: apiKey
      },
      ignoreReturnCode: true,
      listeners: {
        stdout: (data: Buffer) => {
          stdout += data.toString('utf8')
          const runId = parseRunIdFromOutput(stdout)
          if (runId && runId !== savedRunId) {
            savedRunId = runId
            core.saveState(RUN_ID_STATE, runId)
          }
        }
      }
    })
  } catch (error) {
    // Show Oz logs for troubleshooting.
    await logOzLogFile(channel)
    throw error
  }

  core.saveState(EXIT_CODE_STATE, String(execResult.exitCode))

  if (execResult.exitCode !== 0) {
    await logOzLogFile(channel)
    throw new Error(`The process '${command}' failed with exit code ${execResult.exitCode}`)
  }

  core.setOutput('agent_output', execResult.stdout)
}

export async function reportShutdown(): Promise<void> {
  const runId = core.getState(RUN_ID_STATE)
  if (!runId) {
    core.info('No Oz run ID was captured; skipping shutdown report.')
    return
  }

  const apiKey = core.getInput('warp_api_key')
  if (!apiKey) {
    core.warning('`warp_api_key` is unavailable; skipping shutdown report.')
    return
  }

  const channel = core.getInput('oz_channel')
  let command: string
  try {
    command = commandForChannel(channel)
  } catch (error) {
    core.warning(error instanceof Error ? error.message : String(error))
    return
  }

  const args = buildReportShutdownArgs(runId, core.getState(EXIT_CODE_STATE))
  const result = await exec.getExecOutput(command, args, {
    env: {
      ...process.env,
      WARP_API_KEY: apiKey
    },
    ignoreReturnCode: true
  })

  if (result.exitCode === 0) {
    core.info(`Reported shutdown for ${runId}`)
  } else {
    core.warning(`Error reporting shutdown for ${runId}`)
  }
}

export async function run(): Promise<void> {
  // When the main process runs, it saves a marker to the GHA state.
  // If this marker is set, we're running the post-action cleanup.
  if (core.getState(MAIN_STARTED_STATE)) {
    await reportShutdown()
  } else {
    await runAgent()
  }
}

// Install the Oz CLI, using the specified channel and version.
async function installOz(channel: string, version: string): Promise<void> {
  await core.group('Installing Oz', async () => {
    const ozDeb = await downloadOzDeb(channel, version)
    // Install the .deb file, and then use apt-get to install any dependencies.
    await exec.exec('sudo', ['dpkg', '-i', ozDeb])
    await exec.exec('sudo', ['apt-get', '-f', 'install'])
  })
}

// Download the .deb file for the Oz CLI. If the version is `latest`, this will resolve the
// latest version on `channel`.
async function downloadOzDeb(channel: string, version: string): Promise<string> {
  if (process.platform !== 'linux') {
    throw new Error(
      `Only Linux runners are supported - the current platform is ${process.platform}`
    )
  }

  let debUrl: string
  let arch: string
  let debArch: string

  if (process.arch === 'x64') {
    arch = 'x86_64'
    debArch = 'amd64'
  } else if (process.arch === 'arm64') {
    arch = 'aarch64'
    debArch = 'arm64'
  } else {
    throw new Error(`Unsupported architecture ${process.arch}`)
  }

  if (version === 'latest') {
    const client = new http.HttpClient('oz-action', undefined, { allowRedirects: false })
    const response = await client.get(
      `https://app.warp.dev/download/cli?os=linux&package=deb&arch=${arch}&channel=${channel}`
    )

    if (response.message.statusCode === 302 || response.message.statusCode === 301) {
      const location = response.message.headers['location']
      if (!location) {
        throw new Error('Redirect location header missing')
      }
      debUrl = location
      const url = new URL(debUrl)
      const pathComponents = url.pathname.split('/').filter((c) => c)
      // Extract the version component from the URL.
      if (pathComponents.length >= 2) {
        version = pathComponents[1]
      }
    } else {
      throw new Error(`Expected redirect, got status ${response.message.statusCode}`)
    }

    core.info(`Latest version on ${channel} is ${version}`)
  } else {
    let debVersion: string
    if (version.startsWith('v')) {
      debVersion = version.slice(1)
    } else {
      debVersion = version
      version = 'v' + version
    }
    debUrl = `https://releases.warp.dev/${channel}/${version}/oz_${channel}_${debVersion}_${debArch}.deb`
  }

  const cacheVersion = `${channel}-${version}`
  let cachedDeb = tc.find('oz', cacheVersion)
  if (!cachedDeb) {
    core.debug(`Downloading from ${debUrl}...`)
    const downloadedDeb = await tc.downloadTool(debUrl)
    cachedDeb = await tc.cacheFile(downloadedDeb, 'oz.deb', 'oz', cacheVersion)
  } else {
    core.debug('Using cached .deb package')
  }
  return path.join(cachedDeb, 'oz.deb')
}

// Dump the Oz log file contents if it exists.
async function logOzLogFile(channel: string): Promise<void> {
  const stateDir = process.env.XDG_STATE_DIR || path.join(os.homedir(), '.local', 'state')
  const channelSuffix = channel === 'stable' ? '' : `-${channel}`
  const logFileName = channel === 'stable' ? 'warp.log' : `warp_${channel}.log`
  // Note: older versions of Oz may write logs to the parent directory (without the 'oz/' subdirectory),
  // so this path may not exist if the action is run with a pinned older version of Oz.
  const warpLogPath = path.join(stateDir, `warp-terminal${channelSuffix}`, 'oz', logFileName)

  if (fs.existsSync(warpLogPath)) {
    await core.group('Warp Logs', async () => {
      try {
        const logContents = fs.readFileSync(warpLogPath, 'utf8')
        core.info(logContents)
      } catch (error) {
        core.warning(`Failed to read warp.log: ${error}`)
      }
    })
  } else {
    core.warning(`warp.log not found at ${warpLogPath}`)
  }
}

if (!process.env.VITEST) {
  try {
    await run()
  } catch (error) {
    if (error instanceof Error) {
      core.setFailed(error.message)
    } else {
      core.setFailed(String(error))
    }
  }
}
