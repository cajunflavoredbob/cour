import styles from "./AvatarButton.module.css";

interface AvatarButtonProps {
  userName: string;
  onClick: () => void;
  /** Circle diameter in px (design: 36 in top bars, 44 in the sheet). */
  size?: number;
}

// The avatar-tap entry point to the account sheet (design: 36px circle,
// accent bg, white initial; "avatar opens the account sheet").
export const AvatarButton = ({ userName, onClick, size = 36 }: AvatarButtonProps) => (
  <button
    type="button"
    className={styles.btn}
    style={{ width: size, height: size, fontSize: Math.round(size * 0.42) }}
    aria-label="Account"
    onClick={onClick}
  >
    {/* Spread first: charAt(0) splits surrogate pairs (an emoji or kanji name rendered as garbage; audit 17). */}
    {([...userName][0] ?? '?').toUpperCase()}
  </button>
);
