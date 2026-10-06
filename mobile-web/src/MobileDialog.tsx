import React, { useLayoutEffect, useRef } from "react";

/** Native HTML dialog supplies modal focus containment and makes the page inert. */
export function MobileDialog({ label, busy = false, onClose, children }: React.PropsWithChildren<{ label: string; busy?: boolean; onClose: () => void }>) {
  const element = useRef<HTMLDialogElement>(null);
  useLayoutEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const dialog = element.current!;
    dialog.showModal();
    return () => { dialog.close(); if (previous?.isConnected) previous.focus(); };
  }, []);
  return <dialog ref={element} className="mobile-modal" aria-label={label} aria-busy={busy} onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}>{children}</dialog>;
}
