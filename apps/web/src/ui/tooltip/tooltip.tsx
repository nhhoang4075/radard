import * as RTooltip from "@radix-ui/react-tooltip";
import type { ReactNode } from "react";
import "./tooltip.css";

export const TooltipProvider = RTooltip.Provider;

export function Tooltip({
  text,
  children,
  side = "bottom",
}: {
  text: string;
  children: ReactNode;
  side?: "top" | "bottom" | "left" | "right";
}) {
  return (
    <RTooltip.Root>
      <RTooltip.Trigger asChild>{children}</RTooltip.Trigger>
      <RTooltip.Portal>
        <RTooltip.Content className="rd-tooltip" side={side} sideOffset={6}>
          {text}
        </RTooltip.Content>
      </RTooltip.Portal>
    </RTooltip.Root>
  );
}
