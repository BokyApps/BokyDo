import { CompletedList } from '../components/CompletedList.js';
import { Page, ViewHeader } from '../components/ViewHeader.js';

/** Everything the user has completed, across every project they can see (newest first). */
export function CompletedPage() {
  return (
    <Page>
      <ViewHeader title="Completed" subtitle="Newest first" />
      <CompletedList />
    </Page>
  );
}
