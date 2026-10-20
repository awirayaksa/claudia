import { useEffect, useRef, useState, type ReactNode } from 'react';

export interface MenuItem {
  label: string;
  onSelect: () => void;
  danger?: boolean;
  /** Indent (submenu entries, e.g. folders under "Move to"). */
  inset?: boolean;
  disabled?: boolean;
  /** One of a set of choices: shows a check mark when chosen. */
  checked?: boolean;
}

/** A button that opens a small list of actions. Closes on outside click and Escape. */
export function Menu({
  trigger,
  items,
  label,
  align = 'right',
  placement = 'below',
}: {
  trigger: ReactNode;
  items: Array<MenuItem | 'separator' | { heading: string }>;
  label: string;
  align?: 'left' | 'right';
  placement?: 'below' | 'above';
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        className="rounded p-1 text-text-secondary hover:bg-background hover:text-text-primary"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setOpen((o) => !o);
        }}
      >
        {trigger}
      </button>
      {open && (
        <div
          role="menu"
          className={`absolute z-50 min-w-44 rounded-md border border-border bg-surface py-1 text-sm shadow-lg ${
            align === 'right' ? 'end-0' : 'start-0'
          } ${placement === 'below' ? 'top-full mt-1' : 'bottom-full mb-1'}`}
        >
          {items.map((item, i) =>
            item === 'separator' ? (
              <div key={i} className="my-1 border-t border-border" />
            ) : 'heading' in item ? (
              <div key={i} className="px-3 pb-1 pt-2 text-xs font-medium uppercase tracking-wide text-text-secondary">
                {item.heading}
              </div>
            ) : (
              <button
                key={i}
                role={item.checked === undefined ? 'menuitem' : 'menuitemradio'}
                aria-checked={item.checked}
                type="button"
                disabled={item.disabled}
                className={`block w-full px-3 py-1.5 text-start hover:bg-background disabled:opacity-50 ${
                  item.inset ? 'ps-6' : ''
                } ${item.danger ? 'text-error' : 'text-text-primary'}`}
                onClick={(e) => {
                  e.stopPropagation();
                  setOpen(false);
                  item.onSelect();
                }}
              >
                {item.label}
                {item.checked && (
                  <span className="float-end ps-3 text-accent" aria-hidden="true">
                    ✓
                  </span>
                )}
              </button>
            )
          )}
        </div>
      )}
    </div>
  );
}
