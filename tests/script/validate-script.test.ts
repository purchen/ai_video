import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { scriptDocumentSchema } from '../../src/domain/schemas';
import type { LanguageModelAdapter } from '../../src/providers/contracts';
import type { ResearchBrief } from '../../src/research/build-brief';
import { buildScript, sectionOrder } from '../../src/script/build-script';
import { validateScript } from '../../src/script/validate-script';
import { ProjectStore } from '../../src/store/project-store';

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
  risks: [],
  publicQuestions: ['名额是否足够？'],
  explanationNotes: [],
  canDraftScript: true,
  status: 'RESEARCHED',
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

describe('validateScript', () => {
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
});

describe('buildScript', () => {
  it('requests structured JSON, validates it, and persists a schema-versioned draft', async () => {
    const requests: unknown[] = [];
    const adapter: LanguageModelAdapter = {
      id: 'deterministic-fake',
      async generate(request) {
        requests.push(request);
        return validScript;
      },
    };
    const parent = await mkdtemp(join(tmpdir(), 'script-build-'));
    temporaryDirectories.push(parent);
    const store = await ProjectStore.create(parent, 'topic-001');

    const script = await buildScript(brief, adapter, store);

    expect(script.sections.map((section) => section.type)).toEqual(sectionOrder);
    expect(requests).toMatchObject([{ responseFormat: 'json' }]);
    expect(JSON.parse(await readFile(join(store.root, 'script-draft.json'), 'utf8'))).toEqual(script);
  });

  it('rejects invalid model output before persistence', async () => {
    const adapter: LanguageModelAdapter = {
      id: 'deterministic-fake',
      async generate() {
        return { ...validScript, estimatedDurationMs: 30_000 };
      },
    };
    const parent = await mkdtemp(join(tmpdir(), 'script-build-'));
    temporaryDirectories.push(parent);
    const store = await ProjectStore.create(parent, 'topic-001');

    await expect(buildScript(brief, adapter, store)).rejects.toThrow(
      'estimated duration must be between 60000 and 120000 ms',
    );
    await expect(readFile(join(store.root, 'script-draft.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
