import styles from "./Loading.module.css";

// Full-viewport branded loader: the lowercase "cour" wordmark gently
// pulses in opacity + scale. Uses the same gradient + display italic
// styling as the Logo wordmark so the brand reads identically here.
export const Loading = () => (
  <div className={styles.root} role="status" aria-label="Loading cour">
    <span className={styles.wordmark} aria-hidden="true">cour</span>
  </div>
);
