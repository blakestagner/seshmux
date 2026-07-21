// Filetype category → the .ft* tint class in ChangesPanel.module.scss.
// Shared by the tree (ChangesPanel) and the search results (SearchView).
import type { FileGlyphCategory } from '../../lib/client/file-glyphs';
import styles from './ChangesPanel.module.scss';

export const FT_CLASS: Record<FileGlyphCategory, string> = {
  styles: styles.ftStyles,
  scriptTs: styles.ftScriptTs,
  scriptJs: styles.ftScriptJs,
  test: styles.ftTest,
  config: styles.ftConfig,
  docs: styles.ftDocs,
  image: styles.ftImage,
  shell: styles.ftShell,
  markup: styles.ftMarkup,
  dim: styles.ftDim,
};
