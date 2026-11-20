import { useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { addTag, NOTE_TAGS_MAX } from '../../lib/notes.js';
import { inputClass } from '../../components/ui.js';

/**
 * Tag chips. Input is normalised exactly like the server (trim, lowercase, no #/,/whitespace,
 * <= 20 tags, 1-50 chars); an invalid tag is rejected with a short inline message.
 */
export function TagEditor({
  tags,
  onChange,
  disabled = false,
}: {
  tags: string[];
  onChange: (tags: string[]) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const [value, setValue] = useState('');
  const [error, setError] = useState(false);

  const commit = () => {
    const raw = value;
    setValue('');
    if (!raw.trim()) {
      setError(false);
      return;
    }
    const next = addTag(tags, raw);
    if (next === null) {
      setError(true);
      return;
    }
    setError(false);
    onChange(next);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      commit();
    } else if (e.key === 'Backspace' && value === '' && tags.length > 0) {
      onChange(tags.slice(0, -1));
    }
  };

  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center gap-1.5">
        {tags.map((tag) => (
          <span
            key={tag}
            className="inline-flex items-center gap-1 rounded-full border border-line bg-surface-alt px-2 py-0.5 text-xs"
          >
            #{tag}
            {!disabled && (
              <button
                type="button"
                aria-label={t('notes.tags.remove', { tag, defaultValue: 'Remove tag {{tag}}' })}
                className="text-muted hover:text-fg"
                onClick={() => onChange(tags.filter((x) => x !== tag))}
              >
                ×
              </button>
            )}
          </span>
        ))}
        {!disabled && tags.length < NOTE_TAGS_MAX && (
          <input
            type="text"
            className={`${inputClass} h-8 w-32 flex-1 py-1 text-xs`}
            aria-label={t('notes.tags.add', { defaultValue: 'Add a tag' })}
            placeholder={t('notes.tags.add', { defaultValue: 'Add a tag' })}
            value={value}
            disabled={disabled}
            onChange={(e) => {
              setValue(e.target.value);
              setError(false);
            }}
            onKeyDown={onKeyDown}
            onBlur={commit}
          />
        )}
      </div>
      {error && (
        <p className="text-xs text-danger" role="alert">
          {t('notes.tags.invalid', {
            defaultValue: 'Tags are lowercase words without spaces, # or commas (max {{max}}).',
            max: NOTE_TAGS_MAX,
          })}
        </p>
      )}
    </div>
  );
}
