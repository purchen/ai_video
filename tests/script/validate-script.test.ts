import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { scriptDocumentSchema, type ProjectManifest } from '../../src/domain/schemas';
import type { LanguageModelAdapter } from '../../src/providers/contracts';
import type { ResearchBrief } from '../../src/research/build-brief';
import { approveTopic, type ReviewProject } from '../../src/review/approve';
import { buildScript, sectionOrder } from '../../src/script/build-script';
import { validateScript } from '../../src/script/validate-script';
import { ProjectStore } from '../../src/store/project-store';
import type { TopicCandidate } from '../../src/topic/discover';

const createdAt = '2026-09-01T00:00:00.000Z';
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const brief: ResearchBrief = {
  topic: {
    title: '城市夜校报名服务延长',
    normalizedTopic: '城市夜校|报名服务|2026-09-01',
    questionHook: '城市夜校的报名服务，究竟改变了什么？',
  },
  confirmedFacts: [{
    claimKey: 'registration-extended',
    value: 'affirmed',
    text: '官方公告确认报名服务已延长。',
    sourceIds: ['official-1'],
  }],
  conflicts: [],
  unknowns: [],
  candidateLenses: ['user-experience', 'public-service'],
  chosenLenses: [{ id: 'user-experience', label: '用户体验', text: '服务时间安排', basis: 'everyday-common-sense', sourceIds: [], applicability: '不证明实际效果' }],
  risks: [],
  publicQuestions: ['名额是否足够？'],
  explanationNotes: [],
  canDraftScript: true,
  status: 'RESEARCHED',
};

const candidate: TopicCandidate = {
  title: brief.topic.title,
  normalizedTopic: brief.topic.normalizedTopic,
  questionHook: brief.topic.questionHook,
  sourceUrls: ['https://example.com/official'],
  sourcePublishers: ['Example'],
  risks: [],
  eligibleForRecommendation: true,
  score: { relevance: 5, tension: 4, evidenceAvailability: 5, independentJudgment: 5, laneFit: 5, visualDifficulty: 2, risk: 1, total: 4.5 },
};

const validScript = {
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
  createdAt,
  updatedAt: createdAt,
};

async function scriptProject(state: ProjectManifest['workflowState']) {
  const parent = await mkdtemp(join(tmpdir(), 'script-build-'));
  temporaryDirectories.push(parent);
  const store = await ProjectStore.create(parent, 'topic-001');
  return {
    store,
    manifest: {
      schemaVersion: 1 as const,
      id: 'topic-001',
      topic: brief.topic.title,
      workflowState: state,
      createdAt,
      updatedAt: createdAt,
      sources: [{
        schemaVersion: 1 as const,
        id: 'official-1',
        url: 'https://example.com/official',
        title: 'Official notice',
        publisher: 'Example',
        summary: '官方公告确认报名服务已延长。',
        sourceType: 'official-data' as const,
        evidenceWeight: 'high' as const,
        capturedAt: createdAt,
      }],
    },
  };
}

async function durablyApprovedProject(): Promise<ReviewProject> {
  const project = await scriptProject('TOPIC_REVIEW_REQUIRED');
  const reviewProject: ReviewProject = {
    ...project,
    candidates: [{ id: 'candidate-001', candidate }],
    brief,
  };
  await approveTopic(reviewProject, 'candidate-001', 'editor');
  return reviewProject;
}

function countWrites(project: ReviewProject): () => number {
  const original = project.store.writeJson.bind(project.store);
  let writes = 0;
  project.store.writeJson = async (name, schema, value) => {
    writes += 1;
    await original(name, schema, value);
  };
  return () => writes;
}

describe('validateScript', () => {
  it('accepts analysis bound to earlier facts and attributed statements bound to a recorded speaker/source', () => {
    const script = semanticScript();
    expect(validateScript(script, brief, semanticSources()).errors).toEqual([]);
    expect(scriptDocumentSchema.parse(script).sentences.find(s => s.type === 'analysis')?.priorFactSentenceIds).toEqual(['sentence-fact-baseline']);
  });
  it.each(['missing', 'future', 'not-fact'] as const)('rejects analysis with %s prior-fact binding', mode => {
    const script = semanticScript();
    const analysis = script.sentences.find(s => s.type === 'analysis')!;
    analysis.priorFactSentenceIds = mode === 'missing' ? [] : [mode === 'future' ? 'sentence-judgment' : 'sentence-question-hook'];
    if (mode === 'future') Object.assign(script.sentences.find(s => s.id === 'sentence-judgment')!, { type: 'fact', sourceIds: ['official-1'], attribution: '官方公告' });
    expect(validateScript(script, brief, semanticSources()).errors.join(';')).toMatch(/analysis.*prior fact/i);
  });
  it('uses narration section order even when the sentence storage array is shuffled', () => {
    const script = semanticScript(); script.sentences.reverse();
    expect(validateScript(script, brief, semanticSources()).errors).toEqual([]);
  });
  it.each(['missing-source', 'wrong-speaker'] as const)('rejects attribution with %s', mode => {
    const script = semanticScript();
    const sentence = script.sentences.find(s => s.type === 'attribution')!;
    if (mode === 'missing-source') sentence.attributionSourceId = 'unknown'; else sentence.attribution = 'unrecorded person';
    expect(validateScript(script, brief, semanticSources()).errors.join(';')).toMatch(/attribution.*source|attribution.*speaker/i);
  });
  it('requires at least one chosen mechanism lens', () => {
    expect(validateScript({ ...validScript, sections: validScript.sections.map(s => ({ ...s, lenses: [] })) }, brief).errors.join(';')).toMatch(/at least one.*lens/);
  });
  it('rejects fact sentences without source ids', () => {
    const result = validateScript({
      ...validScript,
      sentences: [{ id: 's1', type: 'fact', text: '该事件发生在昨天。', sourceIds: [], attribution: '官方公告' }],
    }, brief);

    expect(result.errors).toContain('fact sentence s1 requires at least one source');
  });

  it('rejects scripts outside the inclusive 60 to 120 second speaking window', () => {
    expect(validateScript({ ...validScript, estimatedDurationMs: 45_000 }, brief).errors)
      .toContain('estimated duration must be between 60000 and 120000 ms');
    expect(validateScript({ ...validScript, estimatedDurationMs: 60_000 }, brief).errors).not
      .toContain('estimated duration must be between 60000 and 120000 ms');
    expect(validateScript({ ...validScript, estimatedDurationMs: 120_000 }, brief).errors).not
      .toContain('estimated duration must be between 60000 and 120000 ms');
  });

  it('requires the seven sections in exact order', () => {
    const reversed = [...validScript.sections].reverse();
    expect(validateScript({ ...validScript, sections: reversed }, brief).errors)
      .toContain('script sections must follow the required seven-section order');
  });

  it('makes the fixed section order part of the persisted document schema', () => {
    const reversed = [...validScript.sections].reverse();

    expect(scriptDocumentSchema.safeParse({ ...validScript, sections: reversed }).success).toBe(false);
  });

  it('limits mechanism to two candidate lenses from the research brief', () => {
    const sections = validScript.sections.map((section) => section.type === 'mechanism'
      ? { ...section, lenses: ['user-experience', 'public-service', 'not-in-brief'] }
      : section);

    const errors = validateScript({ ...validScript, sections }, brief).errors;
    expect(errors).toContain('mechanism section may use at most two lenses');
    expect(errors).toContain('mechanism lens not-in-brief is not present in the research brief');
  });

  it('rejects a fact citation that is not a confirmed non-comment source', () => {
    const sentences = validScript.sentences.map((sentence) => sentence.type === 'fact'
      ? { ...sentence, sourceIds: ['comment-1'] }
      : sentence);

    expect(validateScript({ ...validScript, sentences }, brief).errors)
      .toContain('Factual sentence references unknown source comment-1');
  });

  it('requires attribution for facts and forbids citations on opinion', () => {
    const missingAttribution = validScript.sentences.map((sentence) => sentence.type === 'fact'
      ? { ...sentence, attribution: undefined }
      : sentence);
    const mislabeledOpinion = validScript.sentences.map((sentence) => sentence.type === 'opinion'
      ? { ...sentence, sourceIds: ['official-1'] }
      : sentence);

    expect(validateScript({ ...validScript, sentences: missingAttribution }, brief).errors)
      .toContain('fact sentence sentence-fact-baseline requires attribution');
    expect(validateScript({ ...validScript, sentences: mislabeledOpinion }, brief).errors)
      .toContain('opinion sentence sentence-judgment must not carry factual source ids');
  });

  it('rejects facts when no evidence context is available', () => {
    expect(validateScript(validScript).errors).toContain('fact evidence context is required');
  });
});

function semanticSources() {
  return [{ schemaVersion: 1 as const, id: 'official-1', url: 'https://example.com/official', title: 'Notice', publisher: '官方公告', summary: '报名延长', sourceType: 'official-data' as const, evidenceWeight: 'high' as const, capturedAt: createdAt }];
}
function semanticScript() {
  return { ...validScript, sentences: validScript.sentences.map(s => ({ ...s,
    ...(s.id === 'sentence-mechanism' ? { type: 'analysis', priorFactSentenceIds: ['sentence-fact-baseline'] } : {}),
    ...(s.id === 'sentence-strong-evidence' ? { type: 'attribution', attribution: '官方公告', attributionSourceId: 'official-1', sourceIds: ['official-1'] } : {}),
  })) };
}

describe('buildScript', () => {
  it('does not call the model or write files before topic approval', async () => {
    let calls = 0;
    const adapter: LanguageModelAdapter = {
      id: 'deterministic-fake',
      async generate() {
        calls += 1;
        return validScript;
      },
    };
    const project = await scriptProject('TOPIC_REVIEW_REQUIRED');

    await expect(buildScript(project, brief, adapter)).rejects.toThrow(
      'TOPIC_APPROVED is required before DRAFT_SCRIPT',
    );

    expect(calls).toBe(0);
    await expect(access(join(project.store.root, 'script-draft.json'))).rejects.toThrow();
    await expect(access(join(project.store.root, 'project.json'))).rejects.toThrow();
  });

  it('rejects a forged in-memory approved state when no durable topic approval exists', async () => {
    let calls = 0;
    const adapter: LanguageModelAdapter = {
      id: 'deterministic-fake',
      async generate() {
        calls += 1;
        return validScript;
      },
    };
    const project = await scriptProject('TOPIC_APPROVED');

    await expect(buildScript(project, brief, adapter)).rejects.toThrow('topic approval is not committed');

    expect(calls).toBe(0);
    await expect(access(join(project.store.root, 'script-draft.json'))).rejects.toThrow();
  });

  it('does not use a durable Topic A approval to draft Topic B', async () => {
    let calls = 0;
    const adapter: LanguageModelAdapter = {
      id: 'deterministic-fake',
      async generate() {
        calls += 1;
        return validScript;
      },
    };
    const project = await durablyApprovedProject();
    const projectBefore = await readFile(join(project.store.root, 'project.json'), 'utf8');
    const writes = countWrites(project);
    const mismatchedBriefs: ResearchBrief[] = [
      { ...brief, topic: { ...brief.topic, title: '另一个主题' } },
      { ...brief, topic: { ...brief.topic, normalizedTopic: 'different|topic|2026-09-01' } },
      { ...brief, topic: { ...brief.topic, questionHook: '另一个问题？' } },
    ];

    for (const mismatchedBrief of mismatchedBriefs) {
      await expect(buildScript(project, mismatchedBrief, adapter)).rejects.toThrow(
        'research brief topic does not match approved topic',
      );
    }

    expect(calls).toBe(0);
    expect(writes()).toBe(0);
    expect(await readFile(join(project.store.root, 'project.json'), 'utf8')).toBe(projectBefore);
    await expect(access(join(project.store.root, 'script-draft.json'))).rejects.toThrow();
  });

  it('requests structured JSON, persists the draft, and advances to script review', async () => {
    const requests: unknown[] = [];
    const adapter: LanguageModelAdapter = {
      id: 'deterministic-fake',
      async generate(request) {
        requests.push(request);
        return validScript;
      },
    };
    const project = await durablyApprovedProject();

    const script = await buildScript(project, brief, adapter);

    expect(script.sections.map((section) => section.type)).toEqual(sectionOrder);
    expect(requests).toMatchObject([{ responseFormat: 'json' }]);
    const savedDraft = JSON.parse(await readFile(join(project.store.root, 'script-draft.json'), 'utf8'));
    expect(savedDraft).toEqual(script);
    expect(project.manifest.workflowState).toBe('SCRIPT_REVIEW_REQUIRED');
    expect(JSON.parse(await readFile(join(project.store.root, 'project.json'), 'utf8'))).toMatchObject({
      workflowState: 'SCRIPT_REVIEW_REQUIRED',
      script: savedDraft,
    });
  });

  it('rejects invalid model output before persistence', async () => {
    const adapter: LanguageModelAdapter = {
      id: 'deterministic-fake',
      async generate() {
        return { ...validScript, estimatedDurationMs: 30_000 };
      },
    };
    const project = await durablyApprovedProject();

    await expect(buildScript(project, brief, adapter)).rejects.toThrow(
      'estimated duration must be between 60000 and 120000 ms',
    );
    await expect(readFile(join(project.store.root, 'script-draft.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects model output for another project before any store write', async () => {
    const adapter: LanguageModelAdapter = {
      id: 'deterministic-fake',
      async generate() {
        return { ...validScript, projectId: 'another-project' };
      },
    };
    const project = await durablyApprovedProject();
    const projectBefore = await readFile(join(project.store.root, 'project.json'), 'utf8');
    const writes = countWrites(project);

    await expect(buildScript(project, brief, adapter)).rejects.toThrow(
      'script projectId must match durable project id',
    );

    expect(writes()).toBe(0);
    expect(project.manifest.workflowState).toBe('TOPIC_APPROVED');
    expect(await readFile(join(project.store.root, 'project.json'), 'utf8')).toBe(projectBefore);
    await expect(access(join(project.store.root, 'script-draft.json'))).rejects.toThrow();
  });
});
