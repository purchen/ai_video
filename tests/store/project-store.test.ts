import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { projectManifestSchema, sourceRecordSchema } from '../../src/domain/schemas';
import { ProjectStore } from '../../src/store/project-store';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('ProjectStore', () => {
  it('writes validated JSON atomically and records an event hash', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'short-video-store-'));
    temporaryDirectories.push(tempDir);
    const manifest = {
      schemaVersion: 1,
      id: 'topic-001',
      topic: 'A test topic',
      workflowState: 'DISCOVERED',
      createdAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-01T00:00:00.000Z',
      sources: [],
    };

    const store = await ProjectStore.create(tempDir, 'topic-001');
    await store.writeJson('project.json', projectManifestSchema, manifest);
    const saved = JSON.parse(await readFile(join(store.root, 'project.json'), 'utf8'));
    expect(saved.schemaVersion).toBe(1);
    expect(await store.sha256('project.json')).toMatch(/^[a-f0-9]{64}$/);

    const eventHash = await store.appendEvent({
      id: 'event-001',
      type: 'PROJECT_CREATED',
      occurredAt: '2026-09-01T00:00:00.000Z',
      data: { projectId: 'topic-001' },
    });
    expect(eventHash).toMatch(/^[a-f0-9]{64}$/);
    const event = JSON.parse((await readFile(join(store.root, 'events.jsonl'), 'utf8')).trim());
    expect(event.hash).toBe(eventHash);
  });

  it('does not create a target file when schema validation fails', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'short-video-store-'));
    temporaryDirectories.push(tempDir);
    const store = await ProjectStore.create(tempDir, 'topic-001');

    await expect(store.writeJson('source.json', sourceRecordSchema, { id: '' })).rejects.toThrow();
    await expect(readFile(join(store.root, 'source.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
