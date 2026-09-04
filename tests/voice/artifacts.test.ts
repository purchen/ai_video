import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { ProjectStore } from '../../src/store/project-store';
import { assertVoiceAttemptUnused, nodeVoiceArtifactIo, withVoiceAttempt } from '../../src/voice/artifacts';

const temporaryDirectories: string[] = [];
const lowerId = 'abcdefab-cdef-4abc-8def-abcdefabcdef';
const upperId = 'ABCDEFAB-CDEF-4ABC-8DEF-ABCDEFABCDEF';

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function createStore() {
  const directory = await mkdtemp(join(tmpdir(), 'voice-id-'));
  temporaryDirectories.push(directory);
  return ProjectStore.create(directory, 'topic-001');
}

describe('voice attempt helper identity boundaries', () => {
  it.each([[lowerId, upperId], [upperId, lowerId]])('shares the direct helper lock for %s and %s', async (first, second) => {
    const store = await createStore();
    let release!: () => void;
    let entered!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const winner = withVoiceAttempt(store, first, async () => { entered(); await blocked; });
    await started;
    let competingRuns = 0;
    try {
      await expect(withVoiceAttempt(store, second, async () => { competingRuns++; }))
        .rejects.toThrow('voice attempt is already active');
      expect(competingRuns).toBe(0);
    } finally {
      release();
      await winner;
    }
    await expect(withVoiceAttempt(store, second, async () => 'released')).resolves.toBe('released');
  });

  it('canonicalizes uppercase IDs when the unused helper is called directly', async () => {
    const store = await createStore();
    const directory = join(store.root, 'voice', 'transactions', lowerId);
    await nodeVoiceArtifactIo.mkdir(directory);
    await writeFile(join(directory, 'master.wav'), 'owned bytes');
    await expect(assertVoiceAttemptUnused(store, upperId, nodeVoiceArtifactIo))
      .rejects.toThrow('voice attempt already exists');
    expect(await readFile(join(directory, 'master.wav'), 'utf8')).toBe('owned bytes');
  });

  it.skipIf(process.platform !== 'win32').each(['audit', 'transactions'])(
    'rejects a pre-existing uppercase Windows %s directory for a lowercase ID', async (namespace) => {
      const store = await createStore();
      await nodeVoiceArtifactIo.mkdir(join(store.root, 'voice', namespace, upperId));
      await expect(assertVoiceAttemptUnused(store, lowerId, nodeVoiceArtifactIo))
        .rejects.toThrow('voice attempt already exists');
    },
  );
});
