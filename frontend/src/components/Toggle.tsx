import styles from "./Toggle.module.css";

interface ToggleProps {
  checked: boolean;
  onChange: () => void;
  label: string;
}

/** 38x22 track with a 16px knob. Shared by Mandate and Settings. */
export function Toggle({ checked, onChange, label }: ToggleProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={onChange}
      className={`${styles.track} ${checked ? styles.on : ""}`}
    >
      <span className={styles.knob} />
    </button>
  );
}
