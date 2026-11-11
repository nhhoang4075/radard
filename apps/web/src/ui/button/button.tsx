import type { ButtonHTMLAttributes, ReactNode } from "react";
import "./button.css";

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "ghost";
  size?: "md" | "sm";
  icon?: ReactNode;
};

export function Button({
  variant = "primary",
  size = "md",
  icon,
  children,
  type = "button",
  ...rest
}: ButtonProps) {
  return (
    <button
      {...rest}
      type={type}
      className={`rd-btn ${rest.className ?? ""}`.trim()}
      data-variant={variant}
      data-size={size}
    >
      {icon}
      {children}
    </button>
  );
}
