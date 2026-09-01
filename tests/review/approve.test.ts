import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ProjectManifest } from '../../src/domain/schemas';
import {
  approveScript,
  approveTopic,
  hashScript,
  requireTopicApprovalForDraft,
  type ReviewProject,
} from '../../src/review/approve';
import { sectionOrder } from '../../src/script/build-script';
import { ProjectStore } from '../../src/store/project-store';
import type { TopicCandidate } from '../../src/topic/discover';

const now = '2026-09-01T00:00:00.000Z';
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const candidate: TopicCandidate = {
  title: '城市夜校报名服务延长',
  normalizedTopic: '城市夜校|报名服务|2026-09-01',
  questionHook: '城市夜校的报名服务，究竟改变了什么？',
  sourceUrls: ['https://example.com/official'],
  sourcePublishers: ['Example'],
  risks: [],
  eligibleForRecommendation: true,
  score: { relevance: 5, tension: 4, evidenceAvailability: 5, independentJudgment: 5, laneFit: 5, visualDifficulty: 2, risk: 1, total: 4.5 },
};

const script = {
  schemaVersion: 1 as const,
  id: 'script-001',
  projectId: 'topic-001',
  title: '夜校服务的改变',
  sections: sectionOrder.map((type) => ({
    type,
    sentenceIds: [`sentence-${type}`],
    lenses: type === 'mechanism' ? ['user-experience'] : [],
  })),
  sentences: sectionOrder.map((type) => ({
    id: `sentence-${type}`,
    text: type === 'fact-baseline' ? '官方公告确认报名服务已延长。' : `${type} content`,
    type: type === 'fact-baseline' ? 'fact' as const : type === 'judgment' ? 'opinion' as const : 'transition' as const,
    sourceIds: type === 'fact-baseline' ? ['official-1'] : [],
    attribution: type === 'fact-baseline' ? '官方公告' : undefined,
  })),
  estimatedDurationMs: 90_000,
  createdAt: now,
  updatedAt: now,
};

async function reviewProject(state: ProjectManifest['workflowState']): Promise<ReviewProject> {
  const parent = await mkdtemp(join(tmpdir(), 'review-project-'));
  temporaryDirectories.push(parent);
  const store = await ProjectStore.create(parent, 'topic-001');
  return {
    store,
    manifest: {
      schemaVersion: 1,
      id: 'topic-001',
      topic: candidate.title,
      workflowState: state,
      createdAt: now,
      updatedAt: now,
      sources: [{
        schemaVersion: 1,
        id: 'official-1',
        url: 'https://example.com/official',
        title: 'Official notice',
        publisher: 'Example',
        summary: '官方公告确认报名服务已延长。',
        sourceType: 'official-data',
        evidenceWeight: 'high',
        capturedAt: now,
      }],
      script,
    },
    candidates: [{ id: 'candidate-001', candidate }],
    draft: script,
  };
}

describe('human approval gates', () => {
  it('cannot draft before explicit topic approval through the review state API', async () => {
    const project = await reviewProject('TOPIC_REVIEW_REQUIRED');

    expect(() => requireTopicApprovalForDraft(project)).toThrow(
      'TOPIC_APPROVED is required before DRAFT_SCRIPT',
    );
  });

  it('cannot approve a topic unless review is pending and a human actor is explicit', async () => {
    const wrongState = await reviewProject('RESEARCHED');
    const waiting = await reviewProject('TOPIC_REVIEW_REQUIRED');

    await expect(approveTopic(wrongState, 'candidate-001', 'editor')).rejects.toThrow(
      'TOPIC_REVIEW_REQUIRED is required before APPROVE_TOPIC',
    );
    await expect(approveTopic(waiting, 'candidate-001', '')).rejects.toThrow('approval actor is required');
  });

  it('persists the selected topic card and advances state only on explicit approval', async () => {
    const project = await reviewProject('TOPIC_REVIEW_REQUIRED');

    const approval = await approveTopic(project, 'candidate-001', 'editor');

    expect(approval).toMatchObject({ schemaVersion: 1, approvedBy: 'editor', candidateId: 'candidate-001' });
    expect(project.manifest.workflowState).toBe('TOPIC_APPROVED');
    expect(JSON.parse(await readFile(join(project.store.root, 'topic-card.json'), 'utf8'))).toEqual(approval);
  });

  it('cannot approve a script until script review is pending', async () => {
    const project = await reviewProject('SCRIPT_DRAFTED');

    await expect(approveScript(project, 'editor')).rejects.toThrow(
      'SCRIPT_REVIEW_REQUIRED is required before APPROVE_SCRIPT',
    );
  });

  it('persists an immutable approved script and advances state on human approval', async () => {
    const project = await reviewProject('SCRIPT_REVIEW_REQUIRED');

    const approved = await approveScript(project, 'editor');

    expect(approved.scriptHash).toMatch(/^[a-f0-9]{64}$/);
    expect(project.manifest.workflowState).toBe('SCRIPT_APPROVED');
    expect(Object.isFrozen(approved.script)).toBe(true);
    expect(JSON.parse(await readFile(join(project.store.root, 'approved-script.json'), 'utf8'))).toEqual(approved);
    expect(() => { (approved.script as { title: string }).title = 'mutated'; }).toThrow();
  });
});

describe('approved script hash', () => {
  it('is stable across object key insertion order and approval metadata', () => {
    const reordered = {
      updatedAt: script.updatedAt,
      createdAt: script.createdAt,
      estimatedDurationMs: script.estimatedDurationMs,
      sentences: script.sentences,
      sections: script.sections,
      title: script.title,
      projectId: script.projectId,
      id: script.id,
      schemaVersion: script.schemaVersion,
    };

    expect(hashScript(script)).toBe(hashScript(reordered));
  });

  it('changes when script content changes', () => {
    expect(hashScript(script)).not.toBe(hashScript({ ...script, title: 'changed title' }));
  });
});
