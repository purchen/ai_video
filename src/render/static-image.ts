/** Browser <img> animation uses wall-clock time, so only static raster assets are allowed. */
export function assertStaticImage(data: Buffer, extension: string): void {
  if (extension === '.png') {
    if (
      !data
        .subarray(0, 8)
        .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    )
      throw new Error('invalid PNG');
    for (let offset = 8; offset + 12 <= data.length; ) {
      const length = data.readUInt32BE(offset);
      const type = data.toString('ascii', offset + 4, offset + 8);
      if (type === 'acTL') throw new Error('animated PNG is unsupported');
      offset += length + 12;
    }
  } else if (extension === '.webp') {
    if (
      data.toString('ascii', 0, 4) !== 'RIFF' ||
      data.toString('ascii', 8, 12) !== 'WEBP'
    )
      throw new Error('invalid WebP');
    for (let offset = 12; offset + 8 <= data.length; ) {
      const length = data.readUInt32LE(offset + 4);
      const type = data.toString('ascii', offset, offset + 4);
      if (type === 'ANIM' || type === 'ANMF')
        throw new Error('animated WebP is unsupported');
      offset += 8 + length + (length % 2);
    }
  } else if (data[0] !== 0xff || data[1] !== 0xd8)
    throw new Error('invalid JPEG');
}
