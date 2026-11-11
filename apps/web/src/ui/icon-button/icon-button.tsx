import type { ButtonHTMLAttributes, ReactNode } from "react";
import "./icon-button.css";

export type IconButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "aria-label"> & {
  label: string; // accessible name for screen readers, required
  pressed?: boolean;
  children: ReactNode;
};

export function IconButton({
  label,
  pressed,
  children,
  type = "button",
  ...rest
}: IconButtonProps) {
  return (
    <button
      {...rest}
      type={type}
      aria-label={label}
      aria-pressed={pressed}
      className={`rd-icon-btn ${rest.className ?? ""}`.trim()}
    >
      {children}
    </button>
  );
}
