import { CourMark } from "../atoms/CourMark";
import styles from "./Loading.module.css";

// Full-viewport branded loader: the stylized wordmark from the join
// masthead (the mark is the c) gently pulsing in opacity.
export const Loading = () => (
  <div className={styles.root} role="status" aria-label="Loading cour">
    <span className={styles.wordmark} aria-hidden="true" translate="no">
      <CourMark size={58} dotRadius={5.5} />
      <span className={styles.word}>our</span>
    </span>
  </div>
);
