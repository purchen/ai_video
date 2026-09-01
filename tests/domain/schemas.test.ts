import { describe, expect, it } from 'vitest';
import {
  projectManifestSchema,
  scriptDocumentSchema,
  validateEvidenceBindings,
  type ProjectManifest,
  type ScriptDocument,
} from '../../src/domain/schemas';

const capturedAt = '2026-09-01T00:00:00.000Z';

function projectWithFact(
  sourceIds: string[],
  sourceType: 'primary' | 'comment-sample' = 'primary',
): ProjectManifest & { script: ScriptDocument } {
  return {
    schemaVersion: 1,
    id: 'topic-001',
    topic: 'A test topic',
    workflowState: 'SCRIPT_DRAFTED',
    createdAt: capturedAt,
    updatedAt: capturedAt,
    sources: [{
      schemaVersion: 1,
      id: 'source-001',
      url: 'https://example.com/source',
      title: 'Source',
      publisher: 'Example',
      summary: 'Evidence summary',
      sourceType,
      evidenceWeight: 'high',
      capturedAt,
    }],
    script: {
      schemaVersion: 1,
      id: 'script-001',
      projectId: 'topic-001',
      title: 'Script',
      sections: ([
        'question-hook', 'fact-baseline', 'strong-evidence', 'mechanism',
        'counter-evidence', 'judgment', 'closing-question',
      ] as const).map((type) => ({ type, sentenceIds: ['sentence-001'], lenses: [] })),
      sentences: [{ id: 'sentence-001', text: 'A factual claim.', type: 'fact', sourceIds }],
      estimatedDurationMs: 90_000,
      createdAt: capturedAt,
      updatedAt: capturedAt,
    },
  };
}

describe('evidence bindings', () => {
  it('requires every factual sentence to bind at least one source', () => {
    expect(scriptDocumentSchema.safeParse(projectWithFact([]).script).success).toBe(false);
  });

  it('rejects a factual sentence bound to an unknown source', () => {
    expect(() => projectManifestSchema.parse(projectWithFact(['source-missing']))).toThrow(
      'unknown source source-missing',
    );
  });

  it('rejects comment samples as factual evidence', () => {
    expect(() => projectManifestSchema.parse(projectWithFact(['source-001'], 'comment-sample'))).toThrow(
      'comment-sample',
    );
  });

  it('exposes reusable validation for factual evidence bindings', () => {
    const project = projectWithFact(['source-missing']);

    expect(() => validateEvidenceBindings(project.sources, project.script.sentences)).toThrow(
      'unknown source source-missing',
    );
  });
});
