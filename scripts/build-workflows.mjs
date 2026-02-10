#!/usr/bin/env node

import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import yaml from 'yaml'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const repoRoot = path.resolve(__dirname, '..')

/**
 * Scenario metadata used to generate reusable workflows and consumer templates.
 * The example YAML files in `examples/` remain the single source of truth
 * for the actual workflow logic.
 */
const defaultReusableWorkflowInputs = {
  profile: {
    description: 'Optional Oz Agent profile name to use for Oz Agent.',
    required: false,
    default: ''
  },
  model: {
    description: 'Optional Warp model ID to use for Oz Agent.',
    required: false,
    default: ''
  },
  name: {
    description: 'Optional name for this agent task.',
    required: false,
    default: ''
  },
  mcp: {
    description:
      'Optional MCP configuration in JSON format (or a path to an mcp.json file) to start before executing the agent.',
    required: false,
    default: ''
  }
}

const scenarios = [
  {
    scenarioId: 'respond-to-comment',
    exampleFile: 'examples/respond-to-comment.yml',
    mainJobId: 'respond',
    reusableWorkflow: {
      inputs: defaultReusableWorkflowInputs,
      secrets: {
        OZ_API_KEY: {
          description: 'Oz API key used by the Oz Agent.',
          required: true
        }
      }
    },
    consumerTemplate: {
      pinOzAgentVersion: 'v1'
    }
  },
  {
    scenarioId: 'review-pr',
    exampleFile: 'examples/review-pr.yml',
    mainJobId: 'review_pr',
    reusableWorkflow: {
      inputs: defaultReusableWorkflowInputs,
      secrets: {
        OZ_API_KEY: {
          description: 'Oz API key used by the Oz Agent.',
          required: true
        }
      }
    },
    consumerTemplate: {
      pinOzAgentVersion: 'v1'
    }
  },
  {
    scenarioId: 'auto-fix-issue',
    exampleFile: 'examples/auto-fix-issue.yml',
    mainJobId: 'auto_fix',
    reusableWorkflow: {
      inputs: defaultReusableWorkflowInputs,
      secrets: {
        OZ_API_KEY: {
          description: 'Oz API key used by the Oz Agent.',
          required: true
        }
      }
    },
    consumerTemplate: {
      pinOzAgentVersion: 'v1'
    }
  },
  {
    scenarioId: 'daily-issue-summary',
    exampleFile: 'examples/daily-issue-summary.yml',
    mainJobId: 'summarize_issues',
    reusableWorkflow: {
      inputs: defaultReusableWorkflowInputs,
      secrets: {
        OZ_API_KEY: {
          description: 'Oz API key used by the Oz Agent.',
          required: true
        },
        SLACK_WEBHOOK_URL: {
          description: 'Slack webhook URL used to post the daily issue summary.',
          required: true
        }
      }
    },
    consumerTemplate: {
      pinOzAgentVersion: 'v1'
    }
  },
  {
    scenarioId: 'fix-failing-checks',
    exampleFile: 'examples/fix-failing-checks.yml',
    mainJobId: 'fix_failure',
    reusableWorkflow: {
      inputs: defaultReusableWorkflowInputs,
      secrets: {
        OZ_API_KEY: {
          description: 'Oz API key used by the Oz Agent.',
          required: true
        }
      }
    },
    consumerTemplate: {
      pinOzAgentVersion: 'v1'
    }
  },
  {
    scenarioId: 'suggest-review-fixes',
    exampleFile: 'examples/suggest-review-fixes.yml',
    mainJobId: 'suggest_review_fixes',
    reusableWorkflow: {
      inputs: defaultReusableWorkflowInputs,
      secrets: {
        OZ_API_KEY: {
          description: 'Oz API key used by the Oz Agent.',
          required: true
        }
      }
    },
    consumerTemplate: {
      pinOzAgentVersion: 'v1'
    }
  }
]

function deepClone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value))
}

function buildWorkflowCallInputs(inputsConfig) {
  if (!inputsConfig || Object.keys(inputsConfig).length === 0) {
    return undefined
  }
  const inputs = {}
  for (const [name, info] of Object.entries(inputsConfig)) {
    const entry = {
      description: info.description ?? '',
      required: Boolean(info.required),
      type: 'string'
    }
    if (info.default !== undefined) {
      entry.default = info.default
    }
    inputs[name] = entry
  }
  return inputs
}

function buildWorkflowCallSecrets(secretsConfig) {
  if (!secretsConfig || Object.keys(secretsConfig).length === 0) {
    return undefined
  }
  const secrets = {}
  for (const [name, info] of Object.entries(secretsConfig)) {
    const entry = {
      description: info.description ?? '',
      required: Boolean(info.required ?? true)
    }
    secrets[name] = entry
  }
  return secrets
}

function updateOzAgentActionInputs(job, workflowCallInputs) {
  if (!workflowCallInputs || Object.keys(workflowCallInputs).length === 0) return
  if (!job || !Array.isArray(job.steps)) return

  for (const step of job.steps) {
    if (!step || typeof step.uses !== 'string') continue
    if (!step.uses.startsWith('warpdotdev/oz-agent-action@')) continue

    step.with ||= {}

    if ('profile' in workflowCallInputs) {
      // In the examples, profile is wired to vars.WARP_AGENT_PROFILE.
      // In the reusable workflow, allow overriding via an input.
      step.with.profile = "${{ inputs.profile || vars.WARP_AGENT_PROFILE || '' }}"
    }

    if ('model' in workflowCallInputs) {
      step.with.model = "${{ inputs.model || vars.WARP_AGENT_MODEL || '' }}"
    }

    if ('name' in workflowCallInputs) {
      step.with.name = "${{ inputs.name || vars.WARP_AGENT_NAME || '' }}"
    }

    if ('mcp' in workflowCallInputs) {
      step.with.mcp = "${{ inputs.mcp || vars.WARP_AGENT_MCP || '' }}"
    }
  }
}

function pinOzAgentVersionInText(yamlText, version) {
  if (!version) return yamlText
  const pattern = /(uses:\s*warpdotdev\/oz-agent-action@)[^\s]+/g
  return yamlText.replace(pattern, `$1${version}`)
}

function extractLeadingComments(yamlText) {
  const lines = yamlText.split(/\r?\n/)
  const kept = []
  let seenNonComment = false
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) {
      if (!seenNonComment) {
        kept.push(line)
        continue
      }
      break
    }
    if (trimmed.startsWith('#')) {
      if (!seenNonComment) kept.push(line)
      else break
    } else {
      seenNonComment = true
      break
    }
  }
  return kept.join('\n')
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function insertOptionalInputsCommentInConsumerTemplate(yamlText, mainJobId) {
  if (!yamlText || !mainJobId) return yamlText
  if (yamlText.includes('# These inputs are all optional')) return yamlText

  const jobId = escapeRegExp(mainJobId)
  const pattern = new RegExp(`(^\\s{2}${jobId}:\\n\\s{4}uses:.*\\n\\s{4}with:\\n)`, 'm')

  return yamlText.replace(pattern, `$1      # These inputs are all optional\n`)
}

async function generateReusableWorkflow(scenario, exampleYaml) {
  if (!scenario.reusableWorkflow) return

  const exampleObj = yaml.parse(exampleYaml)
  if (!exampleObj || typeof exampleObj !== 'object') {
    throw new Error(`Example workflow ${scenario.exampleFile} did not parse into an object`)
  }
  if (!exampleObj.jobs || Object.keys(exampleObj.jobs).length === 0) {
    throw new Error(`Example workflow ${scenario.exampleFile} does not contain any jobs`)
  }

  // Clone all jobs from the example
  const jobsClone = deepClone(exampleObj.jobs)

  // Allow overriding selected Oz Agent inputs via workflow_call inputs.
  const workflowCallInputs = scenario.reusableWorkflow.inputs
  for (const job of Object.values(jobsClone)) {
    updateOzAgentActionInputs(job, workflowCallInputs)
  }

  const workflowCall = {}
  const inputs = buildWorkflowCallInputs(scenario.reusableWorkflow.inputs)
  if (inputs) {
    workflowCall.inputs = inputs
  }
  const secrets = buildWorkflowCallSecrets(scenario.reusableWorkflow.secrets)
  if (secrets) {
    workflowCall.secrets = secrets
  }

  const reusable = {
    name: exampleObj.name || scenario.scenarioId,
    on: {
      workflow_call: workflowCall
    },
    jobs: jobsClone
  }

  const header =
    `# NOTE: This file is generated from ${scenario.exampleFile}.\n` +
    `# Do not edit this file directly. Instead, edit the example and run: \n` +
    `# npm run gen-workflows\n\n`

  const reusableYaml = header + yaml.stringify(reusable, { lineWidth: 0 })

  const outDir = path.join(repoRoot, '.github', 'workflows')
  await fs.mkdir(outDir, { recursive: true })
  const outPath = path.join(outDir, `${scenario.scenarioId}.yml`)
  await fs.writeFile(outPath, reusableYaml, 'utf8')
}

async function generateConsumerTemplate(scenario, exampleYaml) {
  if (!scenario.consumerTemplate) return

  const exampleObj = yaml.parse(exampleYaml)
  if (!exampleObj || typeof exampleObj !== 'object') {
    throw new Error(`Example workflow ${scenario.exampleFile} did not parse into an object`)
  }
  if (!exampleObj.jobs || Object.keys(exampleObj.jobs).length === 0) {
    throw new Error(`Example workflow ${scenario.exampleFile} does not contain any jobs`)
  }
  if (!scenario.mainJobId || !exampleObj.jobs[scenario.mainJobId]) {
    throw new Error(
      `Example workflow ${scenario.exampleFile} does not contain expected main job '${scenario.mainJobId}'`
    )
  }

  const leadingComments = extractLeadingComments(exampleYaml)

  // Clone all jobs from the example
  const jobsClone = deepClone(exampleObj.jobs)

  const usesRefVersion = scenario.consumerTemplate.pinOzAgentVersion || 'v1'
  const usesRef = `warpdotdev/oz-agent-action/.github/workflows/${scenario.scenarioId}.yml@${usesRefVersion}`

  const withBlock = {}
  if (scenario.reusableWorkflow?.inputs) {
    // Show optional inputs in the template so users know they can override them.
    if ('profile' in scenario.reusableWorkflow.inputs) withBlock.profile = ''
    if ('model' in scenario.reusableWorkflow.inputs) withBlock.model = ''
    if ('name' in scenario.reusableWorkflow.inputs) withBlock.name = ''
    if ('mcp' in scenario.reusableWorkflow.inputs) withBlock.mcp = ''
  }

  const secretsBlock = {}
  if (scenario.reusableWorkflow?.secrets) {
    for (const secretName of Object.keys(scenario.reusableWorkflow.secrets)) {
      secretsBlock[secretName] = '${{ secrets.' + secretName + ' }}'
    }
  }

  // Replace the main job with a workflow call
  const workflowCallJob = { uses: usesRef }
  if (Object.keys(withBlock).length > 0) {
    workflowCallJob.with = withBlock
  }
  if (Object.keys(secretsBlock).length > 0) {
    workflowCallJob.secrets = secretsBlock
  }

  jobsClone[scenario.mainJobId] = workflowCallJob

  const template = {
    name: exampleObj.name || scenario.scenarioId,
    on: exampleObj.on,
    jobs: jobsClone
  }

  const header =
    `# Template workflow generated from ${scenario.exampleFile}.\n` +
    `# Copy this file into .github/workflows/ in your own repository and customize as needed.\n` +
    `# Do not edit this file in-place in this repo; instead, edit the source example and run: \n` +
    `# npm run gen-workflows\n\n`

  const outDir = path.join(repoRoot, 'consumer-workflows')
  await fs.mkdir(outDir, { recursive: true })
  const outPath = path.join(outDir, `${scenario.scenarioId}.yml`)

  let fileContents = header
  if (leadingComments) {
    fileContents += leadingComments + '\n'
  }
  const templateYaml = yaml.stringify(template, { lineWidth: 0 })
  fileContents += insertOptionalInputsCommentInConsumerTemplate(templateYaml, scenario.mainJobId)

  await fs.writeFile(outPath, fileContents, 'utf8')
}

async function main() {
  for (const scenario of scenarios) {
    const examplePath = path.join(repoRoot, scenario.exampleFile)
    const exampleYaml = await fs.readFile(examplePath, 'utf8')

    await generateReusableWorkflow(scenario, exampleYaml)
    await generateConsumerTemplate(scenario, exampleYaml)
  }
}

main().catch((err) => {
  console.error('[build-workflows] Failed:', err)
  process.exitCode = 1
})
