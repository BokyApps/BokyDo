import type { ReportResponse } from '@bokydo/shared';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useId, useRef, useState } from 'react';
import { api } from '../lib/api.js';
import { errorMessage } from '../lib/messages.js';
import { aiCatalogQuery } from '../lib/queries.js';
import {
  countsText,
  generatedText,
  reportBody,
  reportTitle,
  type ReportTarget,
} from '../lib/report.js';
import { Alert, Button } from './ui.js';

/**
 * An on-demand report (ADR 0021): a button that asks for a short written summary of the person's
 * tasks, shown in a card below. The text is plain text only: it can carry other people's words.
 * Shown only when the server offers reports.
 */
export function ReportPanel({
  target,
  label,
  className = '',
}: {
  target: ReportTarget;
  label: string;
  className?: string;
}) {
  const catalog = useQuery(aiCatalogQuery);
  const id = useId();
  const triggerId = `${id}-trigger`;
  const refreshId = `${id}-refresh`;
  const headingId = `${id}-heading`;
  const [report, setReport] = useState<ReportResponse | null>(null);
  // The card is shown from the press until Close. A report that comes back after Close stays hidden.
  const [shown, setShown] = useState(false);
  const cardRef = useRef<HTMLElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);

  const run = useMutation({
    mutationFn: () => api<ReportResponse>('POST', '/api/v1/assist/report', reportBody(target)),
    onSuccess: (data) => setReport(data),
  });

  const visible = shown && report !== null;
  // A new report moves focus to its heading, unless focus is already in the card (Refresh).
  // The trigger is disabled while a report is written, which can drop focus to the page.
  const reportKey = visible ? report.generatedAt : null;
  useEffect(() => {
    if (reportKey === null) return;
    if (!cardRef.current?.contains(document.activeElement)) heading.current?.focus();
  }, [reportKey]);

  // A failed request hands focus back to the control that asked, if it was dropped.
  useEffect(() => {
    if (!shown || !run.isError) return;
    const active = document.activeElement;
    if (!active || active === document.body)
      document.getElementById(visible ? refreshId : triggerId)?.focus();
  }, [run.isError, shown, visible, refreshId, triggerId]);

  if (!catalog.data?.available.includes('reports')) return null;

  // A fresh press starts with no card, so an old report never shows while the new one is written.
  const start = () => {
    setReport(null);
    setShown(true);
    run.mutate();
  };
  // Refresh keeps the current report on screen until the new one arrives.
  const refresh = () => run.mutate();
  const close = () => {
    setShown(false);
    setReport(null);
    document.getElementById(triggerId)?.focus();
  };

  return (
    <div className={className}>
      <div className="flex flex-wrap items-center gap-3">
        <Button id={triggerId} variant="secondary" busy={run.isPending} onClick={start}>
          {label}
        </Button>
        {/* Always mounted, so screen readers hear the status when it changes. */}
        <p aria-live="polite" className="text-sm text-muted">
          {run.isPending ? 'Writing your report…' : visible ? 'Report ready' : ''}
        </p>
      </div>

      {shown && run.isError && (
        <div className="mt-3">
          <Alert>{errorMessage(run.error)}</Alert>
        </div>
      )}

      {visible && (
        <section
          ref={cardRef}
          aria-labelledby={headingId}
          className="mt-3 max-w-2xl space-y-3 rounded-xl border border-line bg-surface p-4 text-sm"
        >
          <h3
            id={headingId}
            ref={heading}
            tabIndex={-1}
            className="font-semibold focus:outline-none"
          >
            {reportTitle(target.kind)}
          </h3>
          {/* The model's words, shown as plain text only. */}
          <p className="break-words whitespace-pre-wrap">{report.report}</p>
          <p className="text-xs text-muted">{countsText(target.kind, report.counts)}</p>
          <p className="text-xs text-muted">{generatedText(report.generatedAt)}</p>
          <div className="flex flex-wrap justify-end gap-2">
            <Button id={refreshId} variant="secondary" busy={run.isPending} onClick={refresh}>
              Refresh
            </Button>
            <Button variant="ghost" onClick={close}>
              Close
            </Button>
          </div>
        </section>
      )}
    </div>
  );
}
