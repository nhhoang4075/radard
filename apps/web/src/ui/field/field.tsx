import type { InputHTMLAttributes, ReactNode } from "react";
import "./field.css";

/** Single-line input. `icon` comes first (e.g. a magnifier). */
export function Field({
  icon,
  ...rest
}: InputHTMLAttributes<HTMLInputElement> & { icon?: ReactNode }) {
  return (
    <span className="rd-field">
      {icon}
      <input {...rest} />
    </span>
  );
}

export function FieldHelp({ children, aside }: { children?: ReactNode; aside?: ReactNode }) {
  return (
    <div className="rd-field-help">
      <span>{children}</span>
      {aside ? <span>{aside}</span> : null}
    </div>
  );
}
