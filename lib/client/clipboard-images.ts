// Pulling image Files out of a paste. Pure (takes a DataTransfer-shaped
// object), so the files/items fallback is testable without a browser.
//
// Which pastes reach this at all: a browser `paste` event on the terminal —
// right-click → Paste, the browser's Edit menu, Cmd-V on macOS, and
// Ctrl+Shift+V where the browser maps it to paste. NOT plain Ctrl+V on
// Windows/Linux: xterm turns that keydown into ^V (\x16) for the PTY and
// cancels it, so no paste event is ever fired (issue #69; Claude Code reads
// ^V as its own clipboard-image paste, so intercepting it needs care).
//
// Where a pasted image shows up depends on how it got onto the clipboard:
//  - a file copied in Finder/Explorer lands in `clipboardData.files`;
//  - a screenshot (raw image bytes, e.g. Win+Shift+S, Cmd-Ctrl-Shift-4) may be
//    ONLY in `clipboardData.items` as a kind:'file' image/* item, with
//    `.files` empty — reading `.files` alone made those pastes a silent no-op.
// When `.files` has images it wins and `.items` (usually the same image
// again) is ignored; otherwise the image items are the fallback.
//
// Text vs image: Excel/Word/OneNote/a browser copy put text/plain AND an image
// RENDERING of it on the clipboard, and the user meant the text — so any text
// beats a raw image. The exception is a copied file: macOS Finder puts the
// file's NAME on the clipboard as text/plain next to the file itself, so a
// `.files` image whose name IS that text still pastes as a file. (Unverified
// on real hardware: Chrome on macOS may expose a Finder-copied file as an
// icon PNG instead, in which case this exception simply never fires.)

type ClipboardLike = {
  files?: ArrayLike<File> | null;
  items?: ArrayLike<Pick<DataTransferItem, 'kind' | 'type' | 'getAsFile'>> | null;
  getData?: (format: string) => string;
};

const isImage = (type: string) => type.startsWith('image/');
// Comparable form of a file name: basename, Unicode-normalized (macOS hands
// out NFD, File.name may be NFC), case-folded.
const norm = (s: string) => (s.split(/[\\/]/).pop() ?? s).normalize('NFC').toLowerCase();
const stripExt = (s: string) => s.replace(/\.[^.]*$/, '');

/** Does the clipboard text name exactly these files (a Finder-style copy)? */
function textNamesFiles(text: string, files: File[]): boolean {
  const lines = new Set(
    text
      .split(/\r\n|\r|\n/)
      .map((l) => norm(l.trim()))
      .filter(Boolean),
  );
  // "Hide extension" in Finder puts the name without its extension.
  return files.every((f) => lines.has(norm(f.name)) || lines.has(stripExt(norm(f.name))));
}

/** Image Files a paste should upload, deduped, each with a usable filename. */
export function imagesFromClipboard(dt: ClipboardLike, now: () => number = Date.now): File[] {
  const text = dt.getData?.('text/plain')?.trim() ?? '';
  let images = Array.from(dt.files ?? []).filter((f) => isImage(f.type));
  if (images.length) {
    // Only a copied file's own name(s) may ride along; any other text means
    // this is a text paste that carries an image rendering.
    if (text && !textNamesFiles(text, images)) return [];
  } else {
    if (text) return [];
    // .items can list one image under several entries — dedupe here only.
    // (.files never repeats a file, and there two same-named, same-sized
    // files are genuinely different.) Name+type+size can in theory merge two
    // distinct items — accepted rather than hashing bytes on every paste.
    const seen = new Set<string>();
    for (const item of Array.from(dt.items ?? [])) {
      if (item.kind !== 'file' || !isImage(item.type)) continue;
      const f = item.getAsFile();
      if (!f) continue;
      const key = `${f.name}\0${f.type}\0${f.size}`;
      if (seen.has(key)) continue;
      seen.add(key);
      images.push(f);
    }
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
