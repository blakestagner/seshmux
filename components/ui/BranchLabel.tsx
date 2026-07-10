import styles from './BranchLabel.module.scss';

export type BranchLabelProps = {
  branch: string;
};

export default function BranchLabel({ branch }: BranchLabelProps) {
  return <span className={styles.chip}>⎇ {branch}</span>;
}
