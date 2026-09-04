import { readFile, mkdir, access } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { projectManifestSchema, scriptDocumentSchema } from './domain/schemas';
import { assetManifestSchema } from './edit/build-edit-plan';
import { manualAudioAuthorizationSchema } from './providers/tts/manual';
import { ProviderRegistry } from './providers/registry';
import { JsonFeedTopicAdapter } from './providers/topic/json-feed';
import { hashCanonicalJson } from './script/hash-script';
import { ProjectStore } from './store/project-store';
import { commandSchema, runStage, runNextStage, readWorkflowStatus, sourcesArtifactSchema, withProjectLock, type StageDependencies } from './workflow/run-stage';

const configSchema = z.object({ schemaVersion: z.literal(1), provider: z.enum(['manual', 'openai']).default('manual'), budgetCny: z.number().finite().nonnegative().optional(), dryRun: z.boolean().default(false), consent: z.object({ actor: z.string().trim().min(1), reference: z.string().trim().min(1) }).optional() }).strict();
const rawTopicSchema = z.object({ title: z.string().min(1), url: z.string().url(), publisher: z.string().min(1), summary: z.string().optional(), publishedAt: z.string().datetime().optional() });
const readJson = async (path: string): Promise<unknown> => JSON.parse(await readFile(resolve(path), 'utf8'));
const flags = new Set(['project', 'projects-dir', 'feed', 'sources', 'draft', 'assets', 'audio', 'rights', 'actor', 'candidate', 'config', 'provider', 'budget-cny', 'approve-cost-cny', 'consent-by', 'consent-reference', 'dry-run']);
export function resolveProjectInput(value: string, projectsDirectory = 'projects'): string {
  if (!value.trim() || value === '.' || value === '..') throw new Error('project must be an explicit directory path or safe project ID');
  if (isAbsolute(value) || /[\\/]/.test(value)) return resolve(value);
  if (!/^[\p{L}\p{N}_-]+$/u.test(value)) throw new Error('invalid project ID');
  return resolve(projectsDirectory, value);
}
export async function runCli(args: string[], injected: StageDependencies = {}): Promise<number> {
  const print = injected.print ?? console.log;
  try {
    const command = args[0];
    if (!command || command === '--help') { print('Commands: discover research approve-topic draft-script approve-script voice import-voice edit-plan render qc next status\nRequired: --project <path-or-id>. Local inputs: --feed --sources --draft --assets --audio --rights. See docs/cli.md.'); return 0; }
    if (command !== 'status' && command !== 'next' && (!commandSchema.safeParse(command).success || command === 'finish')) throw new Error(`unknown command: ${command}`);
    const options: Record<string, string> = {};
    for (let i = 1; i < args.length; i++) {
      const flag = args[i].replace(/^--/, '');
      if (!args[i].startsWith('--') || !flags.has(flag) || flag in options) throw new Error(`unknown or duplicate option: ${args[i]}`);
      if (flag === 'dry-run') options[flag] = 'true';
      else { if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`value required for --${flag}`); options[flag] = args[++i]; }
    }
    if (!options.project) throw new Error('--project is required');
    const root = resolveProjectInput(options.project, options['projects-dir']);
    if (command === 'status') { const status = await readWorkflowStatus(root, injected); print(JSON.stringify(status, null, 2)); return status.state.startsWith('FAILED_') ? 1 : status.state.startsWith('BLOCKED_') ? 2 : 0; }
    const config = configSchema.parse(options.config ? await readJson(options.config) : { schemaVersion: 1 });
    const deps: StageDependencies = { ...injected, print, dryRun: options['dry-run'] === 'true' || config.dryRun, actor: options.actor, candidateId: options.candidate, limitCny: config.budgetCny, consent: config.consent };
    const amount = options['budget-cny'];
    if (amount !== undefined) deps.limitCny = z.number().finite().nonnegative().parse(Number(amount));
    if (options['approve-cost-cny'] !== undefined) deps.currentCallMaxCny = z.number().finite().nonnegative().parse(Number(options['approve-cost-cny']));
    if (options['consent-by'] || options['consent-reference']) deps.consent = { actor: options['consent-by'] ?? '', reference: options['consent-reference'] ?? '' };
    if (!deps.registry) {
      const provider = z.enum(['manual', 'openai']).parse(options.provider ?? config.provider);
      deps.registry = ProviderRegistry.detect(provider === 'openai' ? { OPENAI_API_KEY: process.env.OPENAI_API_KEY } : {});
    }
    if (options.feed) {
      const payload = await readJson(options.feed); const topics = z.array(rawTopicSchema).parse(payload);
      deps.topicAdapters = [new JsonFeedTopicAdapter({ id: `local-feed:${hashCanonicalJson(topics)}`, url: 'local-input', fetchJson: async () => topics })];
    }
    if (options.sources) deps.sources = sourcesArtifactSchema.parse(await readJson(options.sources)).sources;
    if (options.draft) { const script = scriptDocumentSchema.parse(await readJson(options.draft)); deps.languageModel = { id: `local-draft:${hashCanonicalJson(script)}`, generate: async () => script }; }
    if (options.assets) deps.assets = assetManifestSchema.parse(await readJson(options.assets));
    if (options.audio) deps.audioPath = resolve(options.audio);
    if (options.rights) deps.authorization = manualAudioAuthorizationSchema.parse(await readJson(options.rights));
    if (command === 'discover') {
      await mkdir(root, { recursive: true });
      await withProjectLock(root, async () => {
        try { await access(join(root, 'project.json')); return; } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
        const store = await ProjectStore.create(dirname(root), basename(root)); const now = new Date().toISOString();
        await store.writeJson('project.json', projectManifestSchema, { schemaVersion: 1, id: basename(root), topic: '待选题', workflowState: 'DISCOVERED', createdAt: now, updatedAt: now, sources: [] });
      });
    }
    const state = command === 'next' ? await runNextStage(root, deps) : await runStage(root, commandSchema.parse(command), deps);
    print(state);
    return state.startsWith('FAILED_') ? 1 : state.startsWith('BLOCKED_') || command === 'next' && state.endsWith('_REVIEW_REQUIRED') ? 2 : 0;
  } catch (error) { print(error instanceof Error ? error.message : String(error)); return 1; }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) runCli(process.argv.slice(2)).then(code => { process.exitCode = code; });
