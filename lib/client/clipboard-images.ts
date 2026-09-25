// Pulling image Files out of a paste. Pure (takes a DataTransfer-shaped
// object), so the files/items fallback is testable without a browser.
//
// Where a pasted image shows up depends on how it got onto the clipboard:
//  - a file copied in Finder/Explorer lands in `clipboardData.files`;
//  - a screenshot (raw image bytes, e.g. Win+Shift+S, Cmd-Ctrl-Shift-4) is
//    often ONLY in `clipboardData.items` as a kind:'file' image/* item, with
//    `.files` empty — reading `.files` alone made those pastes a silent no-op.
// Browsers that populate both describe the SAME image twice, so the two lists
// are merged and deduped.
//
// Text always wins: Excel/Word/OneNote/a browser copy put text/plain AND an
// image rendering of it on the clipboard, and the user meant the text. Only a
// paste with no text at all is treated as an image paste.

type ClipboardLike = {
  files?: ArrayLike<File> | null;
  items?: ArrayLike<Pick<DataTransferItem, 'kind' | 'type' | 'getAsFile'>> | null;
  getData?: (format: string) => string;
};

const isImage = (type: string) => type.startsWith('image/');

/** Image Files carried by a text-free paste, deduped, each with a usable filename. */
export function imagesFromClipboard(dt: ClipboardLike, now: () => number = Date.now): File[] {
  if (dt.getData?.('text/plain')?.trim()) return [];
  const candidates: File[] = Array.from(dt.files ?? []);
  for (const item of Array.from(dt.items ?? [])) {
    if (item.kind !== 'file' || !isImage(item.type)) continue;
    const f = item.getAsFile();
    if (f) candidates.push(f);
  }
  const images: File[] = [];
  const seen = new Set<string>();
  for (const f of candidates) {
    if (!isImage(f.type)) continue;
    // One image may be listed in both .files and .items, or under several items.
    const key = `${f.name}\0${f.type}\0${f.size}`;
    if (seen.has(key)) continue;
    seen.add(key);
    images.push(f);
  }
  // A raw-bytes clipboard image can come back nameless; the upload endpoint
  // requires a name. (Repeated "image.png" names are fine — the server picks
  // image-1.png, image-2.png, ... rather than overwriting.)
  return images.map((f, i) => (f.name ? f : new File([f], pastedName(f.type, now(), i), { type: f.type })));
}

function pastedName(type: string, t: number, i: number): string {
  const ext = (type.split('/')[1] ?? '').split('+')[0].replace(/[^a-z0-9]/gi, '') || 'png';
  return `pasted-${t}${i ? `-${i}` : ''}.${ext === 'jpeg' ? 'jpg' : ext}`;
}
