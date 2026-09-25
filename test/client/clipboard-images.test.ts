import { describe, it, expect } from 'vitest';
import { imagesFromClipboard } from '../../lib/client/clipboard-images';

const png = (name = 'shot.png', bytes = 'abc') => new File([bytes], name, { type: 'image/png' });
const item = (f: File | null, kind = 'file', type = f?.type ?? '') => ({ kind, type, getAsFile: () => f });

describe('imagesFromClipboard', () => {
  it('reads a screenshot that is ONLY in .items (files empty) — issue #65', () => {
    const shot = png('image.png');
    expect(imagesFromClipboard({ files: [], items: [item(shot)] })).toEqual([shot]);
  });

  it('still takes a copied image file from .files', () => {
    const f = png('copied.png');
    expect(imagesFromClipboard({ files: [f], items: [] })).toEqual([f]);
  });

  it('does not double-count when the browser puts the same image in both', () => {
    const f = png('copied.png');
    const sameAgain = png('copied.png');
    expect(imagesFromClipboard({ files: [f], items: [item(sameAgain)] })).toEqual([f]);
  });

  it('dedupes one image listed twice in .files', () => {
    expect(imagesFromClipboard({ files: [png('image.png'), png('image.png')] })).toHaveLength(1);
  });

  it('lets a text paste through even when the clipboard also carries an image (Excel/Word)', () => {
    const shot = png('image.png');
    const getData = (t: string) => (t === 'text/plain' ? 'A1\tB1\n' : '');
    expect(imagesFromClipboard({ files: [shot], items: [item(shot)], getData })).toEqual([]);
  });

  it('treats whitespace-only text as no text', () => {
    const shot = png('image.png');
    expect(imagesFromClipboard({ files: [], items: [item(shot)], getData: () => '  ' })).toEqual([shot]);
  });

  it('dedupes one image listed under several items', () => {
    const a = png('image.png');
    const b = png('image.png');
    expect(imagesFromClipboard({ files: [], items: [item(a), item(b)] })).toHaveLength(1);
  });

  it('ignores text items, non-image files, and items with no File', () => {
    const txt = new File(['x'], 'a.txt', { type: 'text/plain' });
    const out = imagesFromClipboard({
      files: [txt],
      items: [item(null, 'string', 'text/plain'), item(txt), item(null, 'file', 'image/png')],
    });
    expect(out).toEqual([]);
  });

  it('names a nameless image so the upload endpoint accepts it', () => {
    const anon = new File(['abc'], '', { type: 'image/jpeg' });
    const [out] = imagesFromClipboard({ files: [], items: [item(anon)] }, () => 1234);
    expect(out.name).toBe('pasted-1234.jpg');
    expect(out.type).toBe('image/jpeg');
    expect(out.size).toBe(3);
  });

  it('tolerates a missing items/files list', () => {
    expect(imagesFromClipboard({})).toEqual([]);
  });
});
