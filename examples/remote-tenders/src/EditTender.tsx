// The remote component of design doc §C4, as written there.
import { useState, type FormEvent } from 'react';
import { useApi, useApiClient, useHasPermission, useRouteTemplate, useT,
         MFEErrorBoundary } from '@bcbp-solutions-fzc-llc/frontend-sdk/react';
import { isProblemError, PlatformProblemTypes, toFieldErrorMap } from '@bcbp-solutions-fzc-llc/frontend-sdk/problem';
import { problemMessage } from '@bcbp-solutions-fzc-llc/frontend-sdk/i18n';

interface Tender { id: string; title: string; deadline: string; version: number }

function EditTenderForm({ id }: { id: string }) {
  useRouteTemplate('/tenders/:id/edit');
  const t = useT('tenders');
  const api = useApiClient();
  const canEdit = useHasPermission('update', 'tender');
  const { data, error, loading, reload } = useApi((c, signal) =>
    c.get<Tender>('/tenders/:id', { params: { id }, signal }).then((r) => r.data), [id]);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});
  const [formError, setFormError] = useState<string>();
  // A save that failed without an answer (timeout, network): thrown while rendering, so MFEErrorBoundary
  // shows it with its request id. (onSubmit's own rejection would go nowhere: it is not React's action.)
  const [failed, setFailed] = useState<{ e: unknown }>();
  if (failed) throw failed.e;

  if (loading) return <p>{t('loading')}</p>;
  if (error) throw error;                       // MFEErrorBoundary renders traceId/requestId
  if (!data) return null;

  // onSubmit, not <form action>: React 19 resets a form's uncontrolled fields once its action completes,
  // which would erase the user's edits next to a 422's field errors.
  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setFieldErrors({}); setFormError(undefined);
    try {
      // The version read: a concurrent edit answers 409 Conflict instead of being overwritten.
      await api.put('/tenders/:id', { params: { id }, body: { ...Object.fromEntries(form), version: data!.version } });
      reload(); // the saved tender, with its new version
    } catch (e) {
      if (!isProblemError(e)) { setFailed({ e }); return; }   // Timeout/Network → boundary
      if (e.is(PlatformProblemTypes.ValidationFailed)) setFieldErrors(toFieldErrorMap(e));
      else if (e.is(PlatformProblemTypes.Conflict)) setFormError(problemMessage(e));
      else setFormError(problemMessage(e));     // localized by type id, falls back to title
    }
  }

  return (
    <form onSubmit={(e) => void onSubmit(e)}>
      <input name="title" defaultValue={data.title} disabled={!canEdit} aria-invalid={!!fieldErrors.title} />
      {fieldErrors.title?.map((m) => <span key={m} role="alert">{m}</span>)}
      <input name="deadline" type="date" defaultValue={data.deadline} disabled={!canEdit} />
      {fieldErrors.deadline?.map((m) => <span key={m} role="alert">{m}</span>)}
      {formError && <p role="alert">{formError}</p>}
      {canEdit && <button type="submit">{t('save')}</button>}
    </form>
  );
}

export default function EditTender(props: { id: string }) {
  return <MFEErrorBoundary mfe="tenders" resetKeys={[props.id]}><EditTenderForm {...props} /></MFEErrorBoundary>;
}
