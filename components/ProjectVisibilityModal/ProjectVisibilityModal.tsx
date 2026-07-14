'use client';
// Rail 3-dot → project show/hide. A thin composition: reusable Modal shell +
// the shared ProjectVisibilityList. Deliberately structure-free so it can grow
// later (queue item #4 is "extended later") without a redesign.
import Modal from '../ui/Modal/Modal';
import ProjectVisibilityList from '../ProjectVisibilityList/ProjectVisibilityList';
import type { Project } from '../../lib/client/types';

export type ProjectVisibilityModalProps = {
  open: boolean;
  onClose: () => void;
  projects: Project[];
  hidden: string[];
  onToggleHidden: (id: string) => void;
};

export default function ProjectVisibilityModal({ open, onClose, projects, hidden, onToggleHidden }: ProjectVisibilityModalProps) {
  return (
    <Modal open={open} onClose={onClose} title="Projects">
      <ProjectVisibilityList projects={projects} hidden={hidden} onToggleHidden={onToggleHidden} />
    </Modal>
  );
}
