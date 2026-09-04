import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { beforeEach, expect, it, vi } from 'vitest';
import { ZodError } from 'zod';
import { buildMvpProject, mvpSpeechProvenanceSchema } from './build-mvp-project';

const injected = vi.hoisted(() => ({ record: undefined as Record<string, unknown> | undefined }));
vi.mock('node:fs/promises', async importOriginal => {
  const fs = await importOriginal<typeof import('node:fs/promises')>();
  return { ...fs, readFile: async (...args: Parameters<typeof fs.readFile>) => {
    if (String(args[0]).endsWith('speech-provenance.json') && injected.record) return JSON.stringify(injected.record);
    return fs.readFile(...args);
  } };
});
// The only expensive dependency is stopped at its boundary. An invalid input
// reaching this sentinel rather than a ZodError proves preflight was bypassed.
vi.mock('../../src/render/media-tools', () => ({
  resolveManagedMediaTools: async () => { throw new Error('invalid provenance reached media processing'); },
}));

beforeEach(() => { injected.record = undefined; });

it('accepts the preserved version 1 Windows synthetic speech provenance', async () => {
  const record = JSON.parse(await readFile(resolve('tests/fixtures/mvp-project/speech-provenance.json'), 'utf8'));
  expect(mvpSpeechProvenanceSchema.parse(record)).toMatchObject({
    schemaVersion: 1, voiceKind: 'synthetic', voiceId: 'Microsoft Huihui Desktop',
    providerId: 'windows-system-speech-fixture', sourceKind: 'windows-built-in-synthetic',
    model: 'System.Speech / Microsoft Huihui Desktop / zh-CN / rate 2',
  });
});

it.each([
  ['unsupported schema', { schemaVersion: 2 }],
  ['contradictory voice kind', { voiceKind: 'original-human' }],
  ['contradictory voice ID', { voiceId: 'alloy' }],
  ['contradictory provider', { providerId: 'openai' }],
  ['contradictory source kind', { sourceKind: 'jianying-synthetic' }],
  ['contradictory model', { model: 'cloned-real-person' }],
  ['invalid generation time', { generatedAt: 'yesterday' }],
  ['missing provenance', { provenance: undefined }],
  ['blank rights scope', { rightsScope: '  ' }],
] as const)('rejects %s before synthesis or render', async (_name, override) => {
  const realRecord = JSON.parse(await readFile(resolve('tests/fixtures/mvp-project/speech-provenance.json'), 'utf8'));
  injected.record = { ...realRecord, ...override };
  await expect(buildMvpProject(resolve('projects/provenance-rejection-must-not-create'))).rejects.toBeInstanceOf(ZodError);
});
