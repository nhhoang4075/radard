import * as Dialog from "@radix-ui/react-dialog";
import { Link } from "@tanstack/react-router";
import { PanelLeft, Search as SearchIcon, X } from "lucide-react";
import { createContext, type ReactNode, useContext, useState } from "react";
import { createPortal } from "react-dom";
import { strings } from "../lib/strings.vi.ts";
import { IconButton } from "../ui/icon-button/index.ts";
import { Tooltip } from "../ui/tooltip/index.ts";
import "./app-shell.css";
import { NAV_ITEMS } from "./nav-items.ts";
import { useShellState } from "./use-shell-state.ts";

const PanelCtx = createContext<{
  el: HTMLElement | null;
  open: boolean;
  setOpen: (o: boolean) => void;
}>({
  el: null,
  open: false,
  setOpen: () => {},
});

/** Content of the right panel: render anywhere in the shell, shown in the panel column. */
export function ShellPanel({ children }: { children: ReactNode }) {
  const { el } = useContext(PanelCtx);
  return el ? createPortal(children, el) : null;
}

/** Open/close the right panel on narrow screens (<1100px the panel is a slide-in sheet). */
export const useShellPanel = () => {
  const { open, setOpen } = useContext(PanelCtx);
  return { open, setOpen };
};

function NavList({ onNavigate }: { onNavigate?: () => void }) {
  const groups = [
    { key: "main", head: null },
    { key: "owner", head: strings.nav.ownerGroup },
  ] as const;
  return (
    <nav aria-label={strings.nav.label}>
      {groups.map((g) => (
        <div key={g.key}>
          {g.head ? <div className="rd-nav-head">{g.head}</div> : null}
          {NAV_ITEMS.filter((i) => i.group === g.key).map((i) =>
            i.to ? (
              <Link
                key={i.id}
                to={i.to}
                className="rd-nav"
                activeOptions={{ exact: true }}
                activeProps={{ "aria-current": "page" }}
                onClick={onNavigate}
              >
                <i.Icon aria-hidden />
                <span className="rd-nav-label">{strings.nav.items[i.id]}</span>
              </Link>
            ) : (
              <button key={i.id} type="button" className="rd-nav" disabled title={strings.nav.soon}>
                <i.Icon aria-hidden />
                <span className="rd-nav-label">{strings.nav.items[i.id]}</span>
                <span className="rd-nav-tag">{strings.nav.soonTag}</span>
              </button>
            ),
          )}
        </div>
      ))}
    </nav>
  );
}

function Brand() {
  return (
    <span className="rd-brand">
      <i aria-hidden="true" />
      <span className="rd-nav-label">{strings.appName}</span>
    </span>
  );
}

export function AppShell({
  crumb,
  sidebarFooter,
  children,
}: {
  crumb: string;
  sidebarFooter?: ReactNode;
  children: ReactNode;
}) {
  const s = useShellState();
  const [panelEl, setPanelEl] = useState<HTMLElement | null>(null);
  const toggleLabel = s.collapsed ? strings.shell.expand : strings.shell.collapse;
  return (
    <PanelCtx.Provider value={{ el: panelEl, open: s.panelOpen, setOpen: s.setPanelOpen }}>
      <div className="rd-shell" data-collapsed={s.collapsed ? "" : undefined}>
        <aside className="rd-side">
          <div className="rd-side-top">
            <Brand />
            <Tooltip text={`${toggleLabel} (⌘B)`}>
              <button
                type="button"
                className="rd-side-toggle"
                aria-label={toggleLabel}
                onClick={s.toggleCollapsed}
              >
                <PanelLeft aria-hidden />
              </button>
            </Tooltip>
          </div>
          <NavList />
          <div className="rd-side-foot">{sidebarFooter}</div>
        </aside>

        <Dialog.Root open={s.drawerOpen} onOpenChange={s.setDrawerOpen}>
          <Dialog.Portal>
            <Dialog.Overlay className="rd-scrim" />
            <Dialog.Content className="rd-drawer" aria-describedby={undefined}>
              <Dialog.Title className="rd-sr">{strings.nav.label}</Dialog.Title>
              <div className="rd-side-top">
                <Brand />
                <Dialog.Close asChild>
                  <button type="button" className="rd-side-toggle" aria-label={strings.shell.close}>
                    <X aria-hidden />
                  </button>
                </Dialog.Close>
              </div>
              <NavList onNavigate={() => s.setDrawerOpen(false)} />
              <div className="rd-side-foot">{sidebarFooter}</div>
            </Dialog.Content>
          </Dialog.Portal>
        </Dialog.Root>

        <div className="rd-main">
          <header className="rd-top">
            <span className="rd-menu-btn">
              <IconButton label={strings.shell.openMenu} onClick={() => s.setDrawerOpen(true)}>
                <PanelLeft aria-hidden />
              </IconButton>
            </span>
            <span className="rd-crumb">{crumb}</span>
            <button type="button" className="rd-top-search" disabled title={strings.nav.soon}>
              <SearchIcon aria-hidden />
              <span>{strings.shell.search}</span>
              <kbd>⌘K</kbd>
            </button>
          </header>
          <div className="rd-views">
            <div className="rd-content">{children}</div>
            {s.panelOpen ? (
              <button
                type="button"
                className="rd-scrim rd-panel-scrim"
                aria-label={strings.shell.close}
                onClick={() => s.setPanelOpen(false)}
              />
            ) : null}
            <aside className="rd-panel" ref={setPanelEl} data-open={s.panelOpen ? "" : undefined} />
          </div>
        </div>
      </div>
    </PanelCtx.Provider>
  );
}
