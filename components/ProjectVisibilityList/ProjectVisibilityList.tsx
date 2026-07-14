'use client';
// Shared project show/hide list — rendered by both the rail's 3-dot Project
// Visibility modal and the Customizations "Projects" section (hard rule 2:
// one visual, composed, never redrawn twice). Toggle ON = visible in rail;
// OFF adds the id to config.hidden. Renders state.projects UNFILTERED by
// `hidden`, so an all-hidden state is always recoverable here.
import Toggle from '../ui/Toggle/Toggle';
import styles from './ProjectVisibilityList.module.scss';
import type { Project } from '../../lib/client/types';

export type ProjectVisibilityListProps = {
  projects: Project[];
  hidden: string[];
  onToggleHidden: (id: string) => void;
};

// Pure, testable — the ONE filter rule for the visibility list. Deleted
// worktrees / tmp probes are noise here (rail hides them too, Rail.tsx:97);
// temp-dir cwds are already dropped server-side before they reach the client.
export function visibleProjects(projects: Project[]): Project[] {
  return projects.filter((p) => !p.missing);
}

export default function ProjectVisibilityList({ projects, hidden, onToggleHidden }: ProjectVisibilityListProps) {
  const visible = visibleProjects(projects);

  if (visible.length === 0) {
    return <div className={styles.empty}>No projects yet.</div>;
  }

  return (
    <div className={styles.list}>
      {visible.map((p) => (
        <div key={p.id} className={styles.row}>
          <span className={styles.body}>
            <span className={styles.name}>{p.name}</span>
            <span className={styles.path}>{p.path}</span>
          </span>
          <Toggle on={!hidden.includes(p.id)} onChange={() => onToggleHidden(p.id)} />
        </div>
      ))}
    </div>
  );
}
