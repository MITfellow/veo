import type { Config } from '../substrate/config.js';
import { JOB_NAMES, JobError, type AnyJob, type JobContext, type JobName, type ModelRequest, type StrategyKind } from './types.js';
import { languageJobs } from './jobs/language.js';
import { knowledgeJobs } from './jobs/knowledge.js';
import { attentionJobs } from './jobs/attention.js';

/**
 * The job registry and the one decision point (§33, §59.17).
 *
 * There is exactly one place in this platform that asks whether a model is
 * attached, and it is `selectStrategy` below. Everything else calls
 * `runJob` and gets an answer. That is the whole of what "config-only"
 * means in practice: the conditional exists once, so there is only one
 * thing to change, and it is already written.
 */

const ALL: readonly AnyJob[] = [...languageJobs, ...knowledgeJobs, ...attentionJobs] as readonly AnyJob[];

const BY_NAME: ReadonlyMap<JobName, AnyJob> = new Map(ALL.map((job) => [job.name, job]));

/**
 * Every declared job has an implementation and vice versa.
 *
 * Checked at module load rather than in a test, because a missing job
 * should fail the process rather than fail quietly at the one call site
 * that needed it.
 */
for (const name of JOB_NAMES) {
  if (!BY_NAME.has(name)) throw new JobError('unknown_job', `Job '${name}' is declared but not implemented.`);
}
if (BY_NAME.size !== JOB_NAMES.length) {
  throw new JobError('unknown_job', `Registry holds ${BY_NAME.size} jobs; ${JOB_NAMES.length} are declared.`);
}

export function allJobs(): readonly AnyJob[] {
  return ALL;
}

export function getJob(name: string): AnyJob {
  const job = BY_NAME.get(name as JobName);
  if (job === undefined) throw new JobError('unknown_job', `No such cognitive job: ${name}`);
  return job;
}

/** Is a model configured at all? One predicate, consulted everywhere. */
export function modelAttached(config: Config): boolean {
  return config.model.provider !== 'none' && config.model.name.length > 0;
}

/**
 * Which strategy will serve this job, and why.
 *
 * Returns the reason as well as the answer because the UI shows it and
 * `doctor` prints it. A user who cannot see why they got a template answer
 * will conclude the product is broken rather than unconfigured.
 */
export function selectStrategy(job: AnyJob, config: Config): { kind: StrategyKind; reason: string } {
  if (!modelAttached(config)) {
    return { kind: 'baseline', reason: 'no model configured — running at L1' };
  }
  const allowed = config.model.jobs;
  if (allowed.length > 0 && !allowed.includes(job.name)) {
    return { kind: 'baseline', reason: `model attached but not enabled for ${job.name}` };
  }
  return { kind: 'model', reason: `${config.model.provider}:${config.model.name}` };
}

/** What a caller gets back. The strategy is always reported, never implied. */
export interface JobResult<O> {
  output: O;
  strategy: StrategyKind;
  reason: string;
  /** Present only when a model served the job. */
  tokens?: number | undefined;
}

/**
 * The provider seam.
 *
 * This is the entire missing piece. Everything else — prompts, parsing,
 * schemas, budgets, trust, the firewall pass — is built and tested. A
 * provider is a function from a built request to a raw completion, and
 * attaching one means supplying this and setting `model.provider` in config.
 *
 * It is deliberately not a class, not a plugin system and not a registry of
 * its own: a single function type is the smallest seam that works, and a
 * small seam is a seam that cannot drift.
 */
export type ModelProvider = (request: ModelRequest) => Promise<string>;

export interface RunOptions {
  config: Config;
  /** Absent in this build, by design. See §2 and decision 008. */
  provider?: ModelProvider | undefined;
}

/**
 * Run a job.
 *
 * Input is validated, the strategy is selected, the output is validated
 * against the *same* schema regardless of which strategy produced it, and
 * the strategy is reported. A model that returns something off-schema does
 * not get to poison the caller — it fails, loudly, as `invalid_output`.
 */
export async function runJob<O = unknown>(
  name: string,
  rawInput: unknown,
  ctx: JobContext,
  options: RunOptions,
): Promise<JobResult<O>> {
  const job = getJob(name);

  const parsedInput = job.input.safeParse(rawInput);
  if (!parsedInput.success) {
    throw new JobError(
      'invalid_input',
      `Invalid input for ${job.name}: ${parsedInput.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')}`,
    );
  }
  const input = parsedInput.data as never;

  const { kind, reason } = selectStrategy(job, options.config);
  const produced = kind === 'model'
    ? await runModel(job, input, ctx, options, reason)
    : job.baseline(input, ctx);

  const parsedOutput = job.output.safeParse(produced);
  if (!parsedOutput.success) {
    throw new JobError(
      'invalid_output',
      `${job.name} (${kind}) produced output failing its own schema: ${parsedOutput.error.issues.map((i) => i.message).join('; ')}`,
    );
  }
  return { output: parsedOutput.data as O, strategy: kind, reason };
}

async function runModel(
  job: AnyJob,
  input: never,
  ctx: JobContext,
  options: RunOptions,
  reason: string,
): Promise<unknown> {
  const request = job.model.buildRequest(input, ctx);
  if (options.provider === undefined) {
    // The honest error. Not a silent fallback to the baseline: the caller
    // asked for a configured model and there is no provider to carry it,
    // and quietly answering with something else would hide a misconfiguration
    // behind a plausible result.
    throw new JobError(
      'model_not_attached',
      `${job.name} is configured to use ${reason}, but no provider is compiled into this build. ` +
        'This build ships no model by design (§2). The request was built and validated; only the transport is missing.',
    );
  }
  const raw = await options.provider(request);
  const parsed = job.model.parseResponse(raw, input);
  if (!parsed.ok) throw new JobError('invalid_output', `${job.name}: ${parsed.error}`);
  return parsed.value;
}

/** Shape shown by `/api/jobs` and `arish doctor`. */
export interface JobDescription {
  name: JobName;
  summary: string;
  outputTrust: string;
  baselineQuality: string;
  strategy: StrategyKind;
  reason: string;
}

export function describeJobs(config: Config): JobDescription[] {
  return allJobs().map((job) => {
    const { kind, reason } = selectStrategy(job, config);
    return {
      name: job.name,
      summary: job.summary,
      outputTrust: job.outputTrust,
      baselineQuality: job.baselineQuality,
      strategy: kind,
      reason,
    };
  });
}

export { JobError };
export type { JobContext, JobName, ModelRequest, StrategyKind };
