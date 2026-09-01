import { mkdir, rename, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ZodType } from 'zod';
import type { ProjectStore } from '../store/project-store';

export type VoiceArtifactName =
  | 'master.wav'
  | 'word-timings.json'
  | 'voice-report.json'
  | 'manual-voice-package.json'
  | 'manual-voice.txt';

export async function ensureVoiceDirectory(store: ProjectStore): Promise<string> {
  const directory = boundedVoicePath(store, '.');
  await mkdir(directory, { recursive: true });
  return directory;
}

export function boundedVoicePath(store: ProjectStore, name: VoiceArtifactName | '.'): string {
  const directory = join(store.root, 'voice');
  const target = name === '.' ? directory : join(directory, name);
  const fromRoot = relative(store.root, target);
  if (fromRoot.startsWith('..') || fromRoot === '') {
    throw new Error('voice artifact path must remain within the project root');
  }
  return target;
}

export async function writeVoiceJson<T>(
  store: ProjectStore,
  name: Extract<VoiceArtifactName, `${string}.json`>,
  schema: ZodType<T>,
  value: unknown,
): Promise<void> {
  const validated = schema.parse(value);
  const directory = await ensureVoiceDirectory(store);
  const target = boundedVoicePath(store, name);
  const temporary = join(directory, `.${name}.${randomUUID()}.tmp`);
  await writeFile(temporary, `${JSON.stringify(validated, null, 2)}\n`, 'utf8');
  await rename(temporary, target);
}

export async function writeVoiceText(
  store: ProjectStore,
  name: Extract<VoiceArtifactName, `${string}.txt`>,
  text: string,
): Promise<void> {
  const directory = await ensureVoiceDirectory(store);
  const target = boundedVoicePath(store, name);
  const temporary = join(directory, `.${name}.${randomUUID()}.tmp`);
  await writeFile(temporary, text, 'utf8');
  await rename(temporary, target);
}
