import { countTemplate, serializeTemplateCsv } from '@bokydo/shared';
import { useState } from 'react';
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
  const [choice, setChoice] = useState<TemplateChoice | null>(null);
  const [error, setError] = useState<string | null>(null);

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    setError(null);
    try {
      const { template, warnings } = await readTemplateFile(file);
      setChoice({ template, warnings, defaultName: template.name });
    } catch (err) {
      setError(err instanceof TemplateFileError ? err.message : 'That file could not be read.');
    }
  };

  return (
    <Page>
      <ViewHeader title="Templates" subtitle="Start a project from a template or a CSV file" />

      <Card className="mb-6">
        <h2 className="mb-2 font-semibold">Import a CSV file</h2>
        <p className="mb-4 text-sm text-muted">
          Choose a project exported from Todoist, or a file in the same format (up to 1,000 rows and
          1 MB). You see what it holds before anything is added. Exporting works the other way: open
          a project's menu and choose “Export as CSV”.
        </p>
        {error && (
          <div className="mb-4">
            <Alert>{error}</Alert>
          </div>
        )}
        <label className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-line bg-surface px-4 py-2 text-sm font-medium hover:bg-surface-alt focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-accent">
          Choose CSV file…
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

      <h2 className="mb-3 font-semibold">Gallery</h2>
      <ul className="mb-6 grid gap-4 sm:grid-cols-2" aria-label="Template gallery">
        {GALLERY.map((g) => {
          const counts = countTemplate(g.template);
          return (
            <li key={g.id}>
              <Card className="flex h-full flex-col">
                <h3 className="font-semibold">{g.title}</h3>
                <p className="mt-1 flex-1 text-sm text-muted">{g.summary}</p>
                <p className="mt-2 text-xs text-muted">
                  {counts.sections > 0 && `${counts.sections} sections · `}
                  {counts.tasks} tasks
                </p>
                <div className="mt-3 flex gap-2">
                  <Button
                    onClick={() =>
                      setChoice({
                        template: g.template,
                        warnings: [],
                        defaultName: g.template.name,
                      })
                    }
                    aria-label={`Use the ${g.title} template`}
                  >
                    Use template
                  </Button>
                  <Button
                    variant="ghost"
                    onClick={() =>
                      downloadText(safeFilename(g.title), serializeTemplateCsv(g.template))
                    }
                    aria-label={`Download ${g.title} as CSV`}
                  >
                    Download CSV
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
