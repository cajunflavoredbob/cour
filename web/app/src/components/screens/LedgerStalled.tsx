import { useDispatch } from "../../store";
import styles from "./LedgerStalled.module.css";

/**
 * Shown when the review-ledger fetch has exhausted its retry budget
 * (audit v1.2.0 #5): the old behavior held the wordmark pulse forever
 * with no way out. The retry button re-dispatches the fetch, which also
 * resets the retry budget (createStore's dispatch side-effect).
 */
export const LedgerStalled = () => {
  const dispatch = useDispatch();
  return (
    <div className={styles.screen} role="alert">
      <h1 className={styles.headline}>couldn&apos;t load your season.</h1>
      <p className={styles.text}>
        The server isn&apos;t answering the review request. It may be
        restarting -- try again in a moment.
      </p>
      <button
        type="button"
        className={styles.retry}
        onClick={() => dispatch({ type: "review" })}
        data-test-handle="ledger-retry"
      >
        try again
      </button>
    </div>
  );
};
