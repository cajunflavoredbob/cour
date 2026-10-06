import type { Ref } from "react";
import styles from "./AvatarButton.module.css";

interface AvatarButtonProps {
  userName: string;
  onClick: () => void;
  /** Whether the account menu it opens is open. */
  expanded?: boolean;
  ref?: Ref<HTMLButtonElement>;
  /** Circle diameter in px (design: 36 in top bars, 44 in the sheet). */
  size?: number;
}

// The avatar-tap entry point to the account sheet (design: 36px circle,
// accent bg, white initial; "avatar opens the account sheet").
export const AvatarButton = ({ userName, onClick, expanded = false, ref, size = 36 }: AvatarButtonProps) => (
  <button
    ref={ref}
    type="button"
    className={styles.btn}
    style={{ width: size, height: size, fontSize: Math.round(size * 0.42) }}
    aria-label="Account"
    aria-haspopup="menu"
    aria-expanded={expanded}
    onClick={onClick}
  >
    {/* Spread first: charAt(0) splits surrogate pairs (an emoji or kanji name rendered as garbage; audit 17). */}
    {([...userName][0] ?? '?').toUpperCase()}
  </button>
);
