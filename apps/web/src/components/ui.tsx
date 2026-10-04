import {
  useEffect,
  useId,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';

export function Logo({ className = '' }: { className?: string }) {
  return (
    <span className={`text-xl font-semibold tracking-tight ${className}`}>
      <span className="text-accent">Boky</span>Do
    </span>
  );
}

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <div className={`rounded-2xl border border-line bg-surface p-6 shadow-sm ${className}`}>
      {children}
    </div>
  );
}

/** Centered single-card layout for sign-in and setup screens. */
export function AuthLayout({ children, wide = false }: { children: ReactNode; wide?: boolean }) {
  return (
    <main className="flex min-h-svh items-start justify-center px-4 py-12 sm:items-center">
      <div className={`w-full ${wide ? 'max-w-xl' : 'max-w-sm'}`}>
        <div className="mb-6 text-center">
          <Logo className="text-2xl" />
        </div>
        <Card>{children}</Card>
      </div>
    </main>
  );
}

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  busy?: boolean;
};

export function Button({
  variant = 'primary',
  busy = false,
  className = '',
  children,
  disabled,
  type = 'button',
  ...rest
}: ButtonProps) {
  const styles = {
    primary: 'bg-accent text-on-accent hover:opacity-90 disabled:opacity-50',
    secondary: 'border border-line bg-surface text-fg hover:bg-surface-alt',
    ghost: 'text-muted hover:bg-surface-alt hover:text-fg',
    danger: 'border border-danger/40 text-danger hover:bg-danger/10',
  }[variant];
  return (
    <button
      type={type}
      className={`inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed ${styles} ${className}`}
      disabled={disabled || busy}
      aria-busy={busy}
      {...rest}
    >
      {busy && (
        <span
          className="size-4 animate-spin rounded-full border-2 border-current border-t-transparent"
          aria-hidden
        />
      )}
      {children}
    </button>
  );
}

export function IconButton({
  label,
  children,
  className = '',
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={`inline-flex size-8 items-center justify-center rounded-md text-muted hover:bg-surface-alt hover:text-fg focus-visible:outline-2 focus-visible:outline-accent ${className}`}
      {...rest}
    >
      {children}
    </button>
  );
}

export const inputClass =
  'w-full rounded-lg border border-line bg-bg px-3 py-2 text-sm text-fg placeholder:text-muted focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30';

interface FieldProps {
  label: string;
  hint?: ReactNode;
  hideLabel?: boolean;
  children: (id: string, describedBy: string | undefined) => ReactNode;
}

export function Field({ label, hint, hideLabel, children }: FieldProps) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className={hideLabel ? 'sr-only' : 'block text-sm font-medium text-fg'}>
        {label}
      </label>
      {children(id, hintId)}
      {hint && (
        <p id={hintId} className="text-xs text-muted">
          {hint}
        </p>
      )}
    </div>
  );
}

export function TextField({
  label,
  hint,
  hideLabel,
  ...rest
}: InputHTMLAttributes<HTMLInputElement> & {
  label: string;
  hint?: ReactNode;
  hideLabel?: boolean;
}) {
  return (
    <Field label={label} hint={hint} hideLabel={hideLabel ?? false}>
      {(id, describedBy) => (
        <input id={id} aria-describedby={describedBy} className={inputClass} {...rest} />
      )}
    </Field>
  );
}

export function TextArea({
  label,
  hint,
  ...rest
}: TextareaHTMLAttributes<HTMLTextAreaElement> & { label: string; hint?: ReactNode }) {
  return (
    <Field label={label} hint={hint}>
      {(id, describedBy) => (
        <textarea
          id={id}
          aria-describedby={describedBy}
          className={`${inputClass} min-h-24`}
          {...rest}
        />
      )}
    </Field>
  );
}

export function SelectField({
  label,
  hint,
  options,
  ...rest
}: SelectHTMLAttributes<HTMLSelectElement> & {
  label: string;
  hint?: ReactNode;
  options: { value: string; label: string }[];
}) {
  return (
    <Field label={label} hint={hint}>
      {(id, describedBy) => (
        <select id={id} aria-describedby={describedBy} className={inputClass} {...rest}>
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      )}
    </Field>
  );
}

export function Checkbox({
  label,
  hint,
  ...rest
}: InputHTMLAttributes<HTMLInputElement> & { label: string; hint?: ReactNode }) {
  const id = useId();
  return (
    <div className="flex items-start gap-2">
      <input id={id} type="checkbox" className="mt-0.5 size-4 accent-accent" {...rest} />
      <div>
        <label htmlFor={id} className="text-sm font-medium text-fg">
          {label}
        </label>
        {hint && <p className="text-xs text-muted">{hint}</p>}
      </div>
    </div>
  );
}

export function Alert({
  tone = 'error',
  children,
}: {
  tone?: 'error' | 'warning' | 'success' | 'info';
  children: ReactNode;
}) {
  const styles = {
    error: 'border-danger/40 bg-danger/10 text-danger',
    warning: 'border-warning/50 bg-warning/10 text-fg',
    success: 'border-success/50 bg-success/10 text-fg',
    info: 'border-line bg-surface-alt text-fg',
  }[tone];
  return (
    <div
      role={tone === 'error' ? 'alert' : 'status'}
      className={`rounded-lg border px-3 py-2 text-sm ${styles}`}
    >
      {children}
    </div>
  );
}

export function Spinner() {
  return (
    <div className="flex min-h-svh items-center justify-center" role="status" aria-label="Loading">
      <span className="size-6 animate-spin rounded-full border-2 border-accent border-t-transparent" />
    </div>
  );
}

/** Accessible modal built on the native <dialog> (focus trap and Escape for free). */
export function Dialog({
  open,
  onClose,
  title,
  children,
  wide = false,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    if (!open && el.open) el.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onClick={(e) => {
        if (e.target === ref.current) onClose(); // click on the backdrop
      }}
      aria-labelledby={titleId}
      className={`m-auto w-[calc(100%-2rem)] ${wide ? 'max-w-3xl' : 'max-w-md'} rounded-2xl border border-line bg-surface p-0 text-fg shadow-xl backdrop:bg-black/40`}
    >
      <div className="p-6">
        <h2 id={titleId} className={wide ? 'sr-only' : 'mb-4 text-base font-semibold'}>
          {title}
        </h2>
        {open && children}
      </div>
    </dialog>
  );
}

/** Secrets shown once (recovery codes, one-time passphrases), with copy and download. */
export function SecretList({ items, filename }: { items: string[]; filename: string }) {
  const [copied, setCopied] = useState(false);
  const text = items.join('\n');
  const download = () => {
    const url = URL.createObjectURL(new Blob([text + '\n'], { type: 'text/plain' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  };
  return (
    <div className="space-y-3">
      <ul
        className={`grid gap-2 rounded-lg bg-surface-alt p-3 font-mono text-sm break-all ${
          items.length > 1 && items.every((i) => i.length <= 16) ? 'grid-cols-2' : 'grid-cols-1'
        }`}
      >
        {items.map((i) => (
          <li key={i}>{i}</li>
        ))}
      </ul>
      <div className="flex gap-2">
        <Button
          variant="secondary"
          onClick={() => void navigator.clipboard.writeText(text).then(() => setCopied(true))}
        >
          {copied ? 'Copied' : 'Copy'}
        </Button>
        <Button variant="secondary" onClick={download}>
          Download
        </Button>
      </div>
    </div>
  );
}

/**
 * Anchored popover: the panel opens below its trigger and closes on outside click or Escape.
 * (Positioned in-flow so it works everywhere without the still-patchy CSS anchor API.)
 */
export function Popover({
  trigger,
  children,
  align = 'left',
  open: controlled,
  onOpenChange,
  panelClassName = '',
}: {
  trigger: (props: {
    onClick: () => void;
    'aria-expanded': boolean;
    'aria-haspopup': 'dialog';
  }) => ReactNode;
  children: ReactNode | ((close: () => void) => ReactNode);
  align?: 'left' | 'right';
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  panelClassName?: string;
}) {
  const [uncontrolled, setUncontrolled] = useState(false);
  const open = controlled ?? uncontrolled;
  const setOpen = (v: boolean) => (onOpenChange ? onOpenChange(v) : setUncontrolled(v));
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey, true);
    };
  });
  const close = () => setOpen(false);
  return (
    <div ref={ref} className="relative inline-block">
      {trigger({ onClick: () => setOpen(!open), 'aria-expanded': open, 'aria-haspopup': 'dialog' })}
      {open && (
        <div
          role="dialog"
          className={`absolute z-40 mt-1 min-w-48 rounded-xl border border-line bg-surface p-1 text-sm shadow-lg ${align === 'right' ? 'right-0' : 'left-0'} ${panelClassName}`}
        >
          {typeof children === 'function' ? children(close) : children}
        </div>
      )}
    </div>
  );
}

export function MenuItem({
  children,
  onClick,
  danger = false,
  icon,
}: {
  children: ReactNode;
  onClick: () => void;
  danger?: boolean;
  icon?: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-left hover:bg-surface-alt ${danger ? 'text-danger' : 'text-fg'}`}
    >
      {icon && <span className="text-muted">{icon}</span>}
      {children}
    </button>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="rounded border border-line bg-surface-alt px-1.5 py-0.5 font-mono text-xs text-muted">
      {children}
    </kbd>
  );
}
