import {
  projectManifestSchema,
  scriptDocumentSchema,
  scriptSectionOrder,
  type ProjectManifest,
  type ScriptDocument,
} from '../domain/schemas';
import { transition } from '../domain/state-machine';
import type { LanguageModelAdapter } from '../providers/contracts';
import type { ResearchBrief } from '../research/build-brief';
import type { ProjectStore } from '../store/project-store';
import { assertValidScript } from './validate-script';

export const sectionOrder = scriptSectionOrder;

export interface ScriptBuildProject {
  store: ProjectStore;
  manifest: ProjectManifest;
}

export async function buildScript(
  project: ScriptBuildProject,
  brief: ResearchBrief,
  adapter: LanguageModelAdapter,
): Promise<ScriptDocument> {
  if (project.manifest.workflowState !== 'TOPIC_APPROVED') {
    throw new Error('TOPIC_APPROVED is required before DRAFT_SCRIPT');
  }
  if (!brief.canDraftScript || brief.status !== 'RESEARCHED') {
    throw new Error('research brief is not eligible for script drafting');
  }

  const output = await adapter.generate({
    responseFormat: 'json',
    schemaName: 'ScriptDocument',
    prompt: buildPrompt(brief),
  });
  const script = scriptDocumentSchema.parse(output);
  assertValidScript(script, brief);

  const draftedState = transition(project.manifest.workflowState, 'DRAFT_SCRIPT');
  const reviewState = transition(draftedState, 'REQUEST_SCRIPT_REVIEW');
  const manifest = projectManifestSchema.parse({
    ...project.manifest,
    workflowState: reviewState,
    script,
    updatedAt: script.updatedAt,
  });

  await project.store.writeJson('script-draft.json', scriptDocumentSchema, script);
  await project.store.writeJson('project.json', projectManifestSchema, manifest);
  project.manifest = manifest;
  return script;
}

function buildPrompt(brief: ResearchBrief): string {
  return [
    'Return only structured JSON matching the ScriptDocument schema.',
    `Use sections in this exact order: ${sectionOrder.join(', ')}.`,
    'Every fact sentence must cite at least one confirmed source ID and name the attribution.',
    'Opinion and analysis sentences must not be labeled as facts or carry factual source IDs.',
    'Use no more than two mechanism lenses, selected only from candidateLenses.',
    'Set estimatedDurationMs between 60000 and 120000 inclusive.',
    `ResearchBrief JSON: ${JSON.stringify(brief)}`,
  ].join('\n');
}
