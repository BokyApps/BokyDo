import { countTemplate, serializeTemplateCsv } from '@bokydo/shared';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ImportTemplateDialog, type TemplateChoice } from '../components/ImportTemplateDialog.js';
import { Alert, Button, Card } from '../components/ui.js';
import { Page, ViewHeader } from '../components/ViewHeader.js';
import { GALLERY } from '../lib/templates/gallery.js';
import {
  downloadText,
  readTemplateFile,
  safeFilename,
  TemplateFileError,
} from '../lib/templates/files.js';

export function TemplatesPage() {
  const { t } = useTranslation();
  const [choice, setChoice] = useState<TemplateChoice | null>(null);
  const [error, setError] = useState<string | null>(null);

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    setError(null);
    try {
      const { template, warnings } = await readTemplateFile(file);
      setChoice({ template, warnings, defaultName: template.name });
    } catch (err) {
      setError(err instanceof TemplateFileError ? err.message : t('import.readFailed'));
    }
  };

  return (
    <Page>
      <ViewHeader title={t('import.templatesTitle')} subtitle={t('import.templatesSubtitle')} />

      <Card className="mb-6">
        <h2 className="mb-2 font-semibold">{t('import.csvTitle')}</h2>
        <p className="mb-4 text-sm text-muted">{t('import.csvDescription')}</p>
        {error && (
          <div className="mb-4">
            <Alert>{error}</Alert>
          </div>
        )}
        <label className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-line bg-surface px-4 py-2 text-sm font-medium hover:bg-surface-alt focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-accent">
          {t('import.chooseCsv')}
          <input
            type="file"
            accept=".csv,text/csv"
            className="sr-only"
            onChange={(e) => {
              void onFile(e.target.files?.[0]);
              e.target.value = '';
            }}
          />
        </label>
      </Card>

      <h2 className="mb-3 font-semibold">{t('import.galleryTitle')}</h2>
      <ul className="mb-6 grid gap-4 sm:grid-cols-2" aria-label={t('import.galleryAria')}>
        {GALLERY.map((g) => {
          const counts = countTemplate(g.template);
          return (
            <li key={g.id}>
              <Card className="flex h-full flex-col">
                <h3 id={`tpl-${g.id}`} className="font-semibold">
                  {t(`import.gallery.${g.id}.title`, { defaultValue: g.title })}
                </h3>
                <p className="mt-1 flex-1 text-sm text-muted">
                  {t(`import.gallery.${g.id}.summary`, { defaultValue: g.summary })}
                </p>
                <p className="mt-2 text-xs text-muted">
                  {counts.sections > 0 &&
                    `${t('import.countSection', { count: counts.sections })} · `}
                  {t('import.countTask', { count: counts.tasks })}
                </p>
                <div className="mt-3 flex gap-2">
                  <Button
                    id={`tpl-use-${g.id}`}
                    aria-labelledby={`tpl-use-${g.id} tpl-${g.id}`}
                    onClick={() =>
                      setChoice({
                        template: g.template,
                        warnings: [],
                        defaultName: g.template.name,
                      })
                    }
                  >
                    {t('import.useTemplate')}
                  </Button>
                  <Button
                    variant="ghost"
                    id={`tpl-csv-${g.id}`}
                    aria-labelledby={`tpl-csv-${g.id} tpl-${g.id}`}
                    onClick={() =>
                      downloadText(safeFilename(g.title), serializeTemplateCsv(g.template))
                    }
                  >
                    {t('import.downloadCsv')}
                  </Button>
                </div>
              </Card>
            </li>
          );
        })}
      </ul>

      <ImportTemplateDialog choice={choice} onClose={() => setChoice(null)} />
    </Page>
  );
}
