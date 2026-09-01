import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { projectManifestSchema, type ProjectManifest } from '../../src/domain/schemas';
import { approvedScriptSchema, type ApprovedScript } from '../../src/review/approve';
import { hashCanonicalJson, hashScript } from '../../src/script/hash-script';
import { ProjectStore } from '../../src/store/project-store';

export const now = '2026-09-01T00:00:00.000Z';

export function approvedFixture(suffix = ''): ApprovedScript {
  const sectionTypes = [
    'question-hook',
    'fact-baseline',
    'strong-evidence',
    'mechanism',
    'counter-evidence',
    'judgment',
    'closing-question',
  ] as const;
  const script = {
    schemaVersion: 1 as const,
    id: `script-001${suffix}`,
    projectId: 'topic-001',
    title: `夜校服务的改变${suffix}`,
    sections: sectionTypes.map((type) => ({ type, sentenceIds: [`sentence-${type}`], lenses: [] })),
    sentences: sectionTypes.map((type) => ({
      id: `sentence-${type}`,
      text: `${type} 原样文案${suffix}`,
      type: type === 'fact-baseline' ? 'fact' as const : 'transition' as const,
      sourceIds: type === 'fact-baseline' ? ['official-1'] : [],
      attribution: type === 'fact-baseline' ? '官方' : undefined,
    })),
    estimatedDurationMs: 90_000,
    createdAt: now,
    updatedAt: now,
  };
  return approvedScriptSchema.parse({
    schemaVersion: 1,
    transactionId: suffix
      ? '00000000-0000-4000-8000-000000000002'
      : '00000000-0000-4000-8000-000000000001',
    approvedAt: now,
    approvedBy: 'editor',
    scriptHash: hashScript(script),
    script,
  });
}

export async function persistDurableApproval(
  store: ProjectStore,
  approved = approvedFixture(),
): Promise<ApprovedScript> {
  const manifest = projectManifestSchema.parse({
    schemaVersion: 1,
    id: approved.script.projectId,
    topic: approved.script.title,
    workflowState: 'SCRIPT_APPROVED',
    createdAt: now,
    updatedAt: now,
    sources: [{
      schemaVersion: 1,
      id: 'official-1',
      url: 'https://example.com/official',
      title: 'Official notice',
      publisher: 'Example',
      summary: '官方公告。',
      sourceType: 'official-data',
      evidenceWeight: 'high',
      capturedAt: now,
    }],
    script: approved.script,
  });
  const commit = approvalCommit(approved, manifest);
  await store.writeJson('approved-script.json', approvedScriptSchema, approved);
  await store.writeJson('project.json', projectManifestSchema, manifest);
  await writeFile(
    join(store.root, 'script-approval.commit.json'),
    `${JSON.stringify(commit, null, 2)}\n`,
    'utf8',
  );
  return approved;
}

function approvalCommit(approved: ApprovedScript, manifest: ProjectManifest) {
  return {
    schemaVersion: 1,
    transactionId: approved.transactionId,
    approvalType: 'script',
    projectId: manifest.id,
    artifactName: 'approved-script.json',
    artifactHash: hashCanonicalJson(approved),
    projectHash: hashCanonicalJson(manifest),
    projectSnapshot: manifest,
    expectedWorkflowState: 'SCRIPT_APPROVED',
    committedAt: approved.approvedAt,
  };
}
