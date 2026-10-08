import type { ReportKind, ReportRequest, ReportResponse } from '@bokydo/shared';

/** What a report is about: the day, the week, or one project (the page it is asked from). */
export type ReportTarget = { kind: 'day' | 'week' } | { kind: 'project'; projectId: string };

/** The request body the server takes for a target. Only a project report carries a project. */
export function reportBody(target: ReportTarget): ReportRequest {
  return target.kind === 'project'
    ? { kind: 'project', projectId: target.projectId }
    : { kind: target.kind };
}

/** The heading over the report card. */
export function reportTitle(kind: ReportKind): string {
  return { day: 'Plan for today', week: 'Your week', project: 'Project status' }[kind];
}

/**
 * The muted line under a report: what it was written from. A day report only looks at what is
 * overdue and due today, so the other two counts are left out.
 */
export function countsText(kind: ReportKind, counts: ReportResponse['counts']): string {
  const parts = [`${counts.overdue} overdue`, `${counts.today} today`];
  if (kind !== 'day') {
    parts.push(
      `${counts.upcoming} in the next 7 days`,
      `${counts.completed} done in the last 7 days`,
    );
  }
  return `Based on ${parts.join(', ')}`;
}

/** "Generated 9:41 AM", in the browser's own time format. Empty if the time is not a date. */
export function generatedText(iso: string, locale?: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  return `Generated ${at.toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' })}`;
}
