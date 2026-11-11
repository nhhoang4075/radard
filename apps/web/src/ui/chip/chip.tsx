import type { ButtonHTMLAttributes, ReactNode } from "react";
import "./chip.css";

export type ChipProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "aria-pressed"> & {
  pressed?: boolean;
};

/** Bộ lọc dạng nút rời: viền mảnh, chọn = nền xám nhạt. */
export function Chip({ pressed = false, type = "button", ...rest }: ChipProps) {
  return (
    <button
      {...rest}
      type={type}
      aria-pressed={pressed}
      className={`rd-chip ${rest.className ?? ""}`.trim()}
    />
  );
}

export function Seg<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: readonly { value: T; label: ReactNode }[];
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: fieldset khó reset kiểu; nhóm nút có aria-label
    <div className="rd-seg" role="group" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={o.value === value}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
