import {
  useEffect,
  useId,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
} from 'react';

export function Logo({ className = '' }: { className?: string }) {
  return (
    <span className={`text-xl font-semibold tracking-tight ${className}`}>
      <span className="text-brand">Boky</span>Do
    </span>
  );
}

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={`rounded-2xl border border-neutral-200 bg-white p-6 shadow-sm dark:border-neutral-800 dark:bg-neutral-900 ${className}`}
    >
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
  variant?: 'primary' | 'secondary' | 'ghost';
  busy?: boolean;
};

export function Button({
  variant = 'primary',
  busy = false,
  className = '',
  children,
  disabled,
  ...rest
}: ButtonProps) {
  const styles = {
    primary: 'bg-brand text-white hover:bg-brand-dark disabled:bg-brand/50',
    secondary:
      'border border-neutral-300 bg-white text-neutral-800 hover:bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100 dark:hover:bg-neutral-800',
    ghost: 'text-neutral-600 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800',
  }[variant];
  return (
    <button
      className={`inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand disabled:cursor-not-allowed ${styles} ${className}`}
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

const inputClass =
  'w-full rounded-lg border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-900 placeholder:text-neutral-400 focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/30 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-100';

interface FieldProps {
  label: string;
  hint?: ReactNode;
  children: (id: string, describedBy: string | undefined) => ReactNode;
}

export function Field({ label, hint, children }: FieldProps) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  return (
    <div className="space-y-1.5">
      <label
        htmlFor={id}
        className="block text-sm font-medium text-neutral-800 dark:text-neutral-200"
      >
        {label}
      </label>
      {children(id, hintId)}
      {hint && (
        <p id={hintId} className="text-xs text-neutral-500 dark:text-neutral-400">
          {hint}
        </p>
      )}
    </div>
  );
}

export function TextField({
  label,
  hint,
  ...rest
}: InputHTMLAttributes<HTMLInputElement> & { label: string; hint?: ReactNode }) {
  return (
    <Field label={label} hint={hint}>
      {(id, describedBy) => (
        <input id={id} aria-describedby={describedBy} className={inputClass} {...rest} />
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

export function Alert({
  tone = 'error',
  children,
}: {
  tone?: 'error' | 'warning' | 'success' | 'info';
  children: ReactNode;
}) {
  const styles = {
    error:
      'border-red-200 bg-red-50 text-red-800 dark:border-red-900 dark:bg-red-950/50 dark:text-red-200',
    warning:
      'border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-900 dark:bg-amber-950/50 dark:text-amber-200',
    success:
      'border-green-200 bg-green-50 text-green-800 dark:border-green-900 dark:bg-green-950/50 dark:text-green-200',
    info: 'border-neutral-200 bg-neutral-50 text-neutral-700 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-300',
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
      <span className="size-6 animate-spin rounded-full border-2 border-brand border-t-transparent" />
    </div>
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
      <input id={id} type="checkbox" className="mt-0.5 size-4 accent-brand" {...rest} />
      <div>
        <label htmlFor={id} className="text-sm font-medium text-neutral-800 dark:text-neutral-200">
          {label}
        </label>
        {hint && <p className="text-xs text-neutral-500 dark:text-neutral-400">{hint}</p>}
      </div>
    </div>
  );
}

/** Accessible modal built on the native <dialog> (focus trap and Escape for free). */
export function Dialog({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
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
      aria-labelledby={`${title}-title`}
      className="m-auto w-[calc(100%-2rem)] max-w-md rounded-2xl border border-neutral-200 bg-white p-6 text-neutral-900 shadow-xl backdrop:bg-black/40 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-100"
    >
      <h2 id={`${title}-title`} className="mb-4 text-base font-semibold">
        {title}
      </h2>
      {children}
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
        className={`grid gap-2 rounded-lg bg-neutral-100 p-3 font-mono text-sm break-all dark:bg-neutral-950 ${
          items.length > 1 && items.every((i) => i.length <= 16) ? 'grid-cols-2' : 'grid-cols-1'
        }`}
      >
        {items.map((i) => (
          <li key={i}>{i}</li>
        ))}
      </ul>
      <div className="flex gap-2">
        <Button
          type="button"
          variant="secondary"
          onClick={() => void navigator.clipboard.writeText(text).then(() => setCopied(true))}
        >
          {copied ? 'Copied' : 'Copy'}
        </Button>
        <Button type="button" variant="secondary" onClick={download}>
          Download
        </Button>
      </div>
    </div>
  );
}
