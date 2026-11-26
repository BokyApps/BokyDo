import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Dialog, inputClass } from '../../components/ui.js';

export interface PickerItem {
  id: string;
  label: string;
}

/**
 * A small search picker shared by "Link task" (note detail) and "Link note" (task detail). The
 * `search` callback is supplied by the caller so the same control can query notes or local tasks.
 * State is only written from event handlers and the async search callback, never synchronously in
 * an effect body (which would cause cascading renders).
 */
export function ResourcePicker({
  open,
  title,
  placeholder,
  search,
  onPick,
  onClose,
}: {
  open: boolean;
  title: string;
  placeholder: string;
  search: (q: string) => Promise<PickerItem[]>;
  onPick: (id: string) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [q, setQ] = useState('');
  const [results, setResults] = useState<PickerItem[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    const timer = setTimeout(() => {
      void search(q).then(
        (items) => {
          if (!alive) return;
          setResults(items);
          setLoading(false);
        },
        () => {
          if (!alive) return;
          setResults([]);
          setLoading(false);
        },
      );
    }, 200);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [open, q, search]);

  // Reset (and arm the loading state for the next open) from event handlers, not an effect.
  const close = () => {
    setQ('');
    setResults([]);
    setLoading(true);
    onClose();
  };

  return (
    <Dialog open={open} onClose={close} title={title}>
      <div className="space-y-3">
        <input
          autoFocus
          type="search"
          className={inputClass}
          aria-label={placeholder}
          placeholder={placeholder}
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setLoading(true);
          }}
        />
        {open && loading && (
          <p className="text-sm text-muted" role="status">
            {t('notes.picker.searching', { defaultValue: 'Searching…' })}
          </p>
        )}
        {open && !loading && results.length === 0 && (
          <p className="text-sm text-muted">
            {t('notes.picker.empty', { defaultValue: 'No results' })}
          </p>
        )}
        <ul className="max-h-64 space-y-0.5 overflow-y-auto text-sm">
          {open &&
            results.map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  className="flex w-full rounded-md px-2 py-1.5 text-left hover:bg-surface-alt"
                  onClick={() => {
                    onPick(item.id);
                    close();
                  }}
                >
                  {item.label || t('notes.untitled', { defaultValue: 'Untitled' })}
                </button>
              </li>
            ))}
        </ul>
        <div className="flex justify-end">
          <Button type="button" variant="secondary" onClick={close}>
            {t('common.cancel', { defaultValue: 'Cancel' })}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
