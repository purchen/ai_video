import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import {
  boundedLocalFile,
  publishRenderedFile,
} from '../../src/render/render-video';
import { assertStaticImage } from '../../src/render/static-image';

const temporary: string[] = [];
it('rejects animated raster inputs rather than rendering wall-clock-driven frames', async () => {
  const png = Buffer.alloc(28);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png);
  png.writeUInt32BE(8, 8);
  png.write('acTL', 12);
  expect(() => assertStaticImage(png, '.png')).toThrow(/animated/);
  const webp = Buffer.alloc(28);
  webp.write('RIFF');
  webp.writeUInt32LE(20, 4);
  webp.write('WEBP', 8);
  webp.write('ANIM', 12);
  webp.writeUInt32LE(8, 16);
  expect(() => assertStaticImage(webp, '.webp')).toThrow(/animated/);
});
afterEach(async () => {
  for (const path of temporary.splice(0))
    await rm(path, { force: true, recursive: true });
});
it('refuses asset symlinks/junctions escaping the project, including another Windows volume', async () => {
  const local = resolve('projects/path-tests');
  await mkdir(local, { recursive: true });
  const root = await mkdtemp(join(local, 'root-'));
  temporary.push(root);
  const outside = await mkdtemp(join(tmpdir(), 'render-outside-'));
  temporary.push(outside);
  await writeFile(join(outside, 'asset.png'), 'outside');
  await symlink(
    outside,
    join(root, 'assets'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  await expect(boundedLocalFile(root, 'assets/asset.png')).rejects.toThrow(
    /within/,
  );
});
it('never publishes corrupted partial output and leaves an existing final untouched', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'publish-render-'));
  temporary.push(parent);
  const partial = join(parent, 'final.partial.mp4');
  const final = join(parent, 'final.mp4');
  await writeFile(partial, 'not a movie');
  await expect(publishRenderedFile(partial, final, 6000)).rejects.toThrow();
  await expect(access(final)).rejects.toThrow();
  await writeFile(final, 'existing success');
  await expect(publishRenderedFile(partial, final, 6000)).rejects.toThrow();
  expect(await readFile(final, 'utf8')).toBe('existing success');
});
