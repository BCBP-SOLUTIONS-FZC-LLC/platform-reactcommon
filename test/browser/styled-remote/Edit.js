// The styled test remote's exposed module (integrity.spec.ts): loading it loads its CSS chunk too.
import styles from './Edit.module.css';

export default function Edit() {
  return styles.box;
}
