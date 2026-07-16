import { DialogScrim } from "../molecules/DialogScrim";
import { useDispatch } from "../../store";
import { setStoredTutorialSeen } from "../../utils/prefs";
import styles from "./Tutorial.module.css";

/**
 * The first-run one-pager (audit 17, the owner's spec): a super brief
 * explainer shown once, when the user first lands in a room on this
 * browser (after login AND join -- popping it over the join form read
 * as "before logging in"). Any dismissal (CTA, Escape, backdrop) counts
 * as seen -- a tutorial that keeps coming back is worse than none.
 */
export const Tutorial = () => {
  const dispatch = useDispatch();

  const dismiss = () => {
    setStoredTutorialSeen();
    dispatch({ type: "tutorial", payload: { open: false } });
  };

  return (
    <DialogScrim
      label="How cour works"
      onDismiss={dismiss}
      backdropClassName={styles.backdrop}
      dialogClassName={styles.dialog}
    >
      <h2 className={styles.title}>how cour works</h2>
      <ol className={styles.steps}>
        <li className={styles.step}>
          <span className={styles.stepKicker}>VERDICT THE SEASON</span>
          One title at a time: <strong>Keep</strong>, <strong>Pass</strong>,
          or <strong>Unsure</strong>. Go at your own pace -- nobody waits on
          anybody.
        </li>
        <li className={styles.step}>
          <span className={styles.stepKicker}>IN A HURRY?</span>
          Press and hold <strong>Unsure</strong> to mark everything left
          unsure at once.
        </li>
        <li className={styles.step}>
          <span className={styles.stepKicker}>NOTHING IS FINAL YET</span>
          The review screen shows every verdict; tap any of them to change
          your mind -- right up until you lock in.
        </li>
        <li className={styles.step}>
          <span className={styles.stepKicker}>LOCK IN, THEN RANK</span>
          Rank your keeps; the top five score points, and the room&apos;s
          combined standings decide what you watch.
        </li>
      </ol>
      <button
        type="button"
        className={styles.cta}
        onClick={dismiss}
        data-test-handle="tutorial-dismiss"
      >
        got it, deal me in
      </button>
    </DialogScrim>
  );
};
