// The remote component of design doc §C4, as written there.
import { useState } from 'react';
import { useApi, useApiClient, useHasPermission, useRouteTemplate, useT,
         MFEErrorBoundary } from '@platform/frontend-sdk/react';
import { isProblemError, PlatformProblemTypes, toFieldErrorMap } from '@platform/frontend-sdk/problem';
import { problemMessage } from '@platform/frontend-sdk/i18n';

interface Tender { id: string; title: string; deadline: string; version: number }

function EditTenderForm({ id }: { id: string }) {
  useRouteTemplate('/tenders/:id/edit');
  const t = useT('tenders');
  const api = useApiClient();
  const canEdit = useHasPermission('update', 'tender');
  const { data, error, loading } = useApi((c, signal) =>
    c.get<Tender>('/tenders/:id', { params: { id }, signal }).then((r) => r.data), [id]);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});
  const [formError, setFormError] = useState<string>();

  if (loading) return <p>{t('loading')}</p>;
  if (error) throw error;                       // MFEErrorBoundary renders traceId/requestId
  if (!data) return null;

  async function onSubmit(form: FormData) {
    setFieldErrors({}); setFormError(undefined);
    try {
      await api.put('/tenders/:id', { params: { id }, body: Object.fromEntries(form) });
    } catch (e) {
      if (!isProblemError(e)) throw e;          // Timeout/Network → boundary
      if (e.is(PlatformProblemTypes.ValidationFailed)) setFieldErrors(toFieldErrorMap(e));
      else if (e.is(PlatformProblemTypes.Conflict)) setFormError(problemMessage(e));
      else setFormError(problemMessage(e));     // localized by type id, falls back to title
    }
  }

  return (
    <form action={onSubmit}>
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
  return <MFEErrorBoundary mfe="tenders"><EditTenderForm {...props} /></MFEErrorBoundary>;
}
