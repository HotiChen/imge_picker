// Mirrors worker.js's proof retention (毛片自動刪除, docs/delivery.md "Proof retention"): the pure parts
// (effectiveProofDays, proofsDeleteAt, proofRetentionInfo, guestProofsInfo) and the body rules of
// POST /api/admin/projects/:id/proofs-retention. Used by pick-fake.mjs (admin detail, the POST, the guest expiry route)
// and dashboard-mocks.mjs (settings PUT). Shared by more than one file in test/suites/.
export const DAY_MS = 86400000;
export const RETENTION_STUDIO_CHOICES = [0, 90, 180, 365];
export const RETENTION_MIN_DAYS = 14;
export const RETENTION_MAX_DAYS = 3650;
export const RETENTION_NOTICE_DAYS = 14;
export const RETENTION_POSTPONE_DAYS = 30;
export const studioProofDaysFake = v => (RETENTION_STUDIO_CHOICES.includes(v) ? v : 0);

export function effectiveProofDaysFake(projectDays, studioDays) {
  if (projectDays !== null && projectDays !== undefined) {
    return Number.isSafeInteger(projectDays) && projectDays >= 0 && projectDays <= RETENTION_MAX_DAYS ? projectDays : 0;
  }
  return RETENTION_STUDIO_CHOICES.includes(studioDays) ? studioDays : 0;
}
export function proofsDeleteAtFake(project, days) {
  if (!project.delivered_at || !project.client_confirmed_at || project.proofs_deleted_at || !(days > 0)) return null;
  const confirmed = Date.parse(project.client_confirmed_at);
  if (!Number.isFinite(confirmed)) return null;
  let at = confirmed + days * DAY_MS;
  if (project.proofs_delete_next_at) {
    const floor = Date.parse(project.proofs_delete_next_at);
    if (!Number.isFinite(floor)) return null;
    if (floor > at) at = floor;
  }
  return at;
}
export function proofRetentionInfoFake(project, studioDays, available, nowMs) {
  const projectDays = available ? project.proof_retention_days ?? null : null;
  const studio = available ? studioProofDaysFake(studioDays) : 0;
  const days = available ? effectiveProofDaysFake(projectDays, studio) : 0;
  const at = available ? proofsDeleteAtFake(project, days) : null;
  return {
    available, days, source: projectDays === null ? 'studio' : 'project', project_days: projectDays, studio_days: studio,
    proofs_delete_at: at === null ? null : new Date(at).toISOString(),
    days_left: at === null ? null : Math.max(0, Math.ceil((at - nowMs) / DAY_MS)),
    notice: at !== null && at - nowMs <= RETENTION_NOTICE_DAYS * DAY_MS,
    proofs_deleted_at: available ? project.proofs_deleted_at ?? null : null,
  };
}
export function guestProofsInfoFake(project, studioDays, available, isOwner, nowMs) {
  const i = proofRetentionInfoFake(project, studioDays, available, nowMs);
  return {
    proofs_delete_at: i.proofs_delete_at, days_left: i.days_left, notice: i.notice, proofs_deleted_at: i.proofs_deleted_at,
    can_download: project.allow_proof_download === true && !!isOwner && !i.proofs_deleted_at,
  };
}
// The POST: returns {status, body}; mutates `project` like the conditional UPDATE does.
export function postProofsRetentionFake(project, body, studioDays, available, nowMs) {
  const keys = body && typeof body === 'object' && !Array.isArray(body) ? Object.keys(body) : [];
  const daysOk = v => v === null || v === 0 || (Number.isSafeInteger(v) && v >= RETENTION_MIN_DAYS && v <= RETENTION_MAX_DAYS);
  const action = keys.length === 1 && keys[0] === 'days' && daysOk(body.days) ? 'set'
    : keys.length === 1 && keys[0] === 'action' && (body.action === 'postpone' || body.action === 'never') ? body.action : null;
  if (!action) return { status: 400, body: { error: 'Send one of {days: null | 0 | 14..3650}, {action: \'postpone\' | \'never\'}', code: 'invalid_body' } };
  if (!available) return { status: 500, body: { error: '毛片自動刪除功能尚未啟用', code: 'proof_retention_unavailable' } };
  if (project.proofs_deleted_at) return { status: 409, body: { error: '毛片已依設定刪除', code: 'proofs_deleted' } };
  const previous = project.proof_retention_days ?? null;
  let next;
  if (action === 'set') next = body.days;
  else if (action === 'never') next = 0;
  else {
    const current = effectiveProofDaysFake(previous, studioDays);
    if (current <= 0) return { status: 409, body: { error: '這個專案沒有設定自動刪除，不需要延後', code: 'proofs_not_scheduled' } };
    next = current + RETENTION_POSTPONE_DAYS;
    if (next > RETENTION_MAX_DAYS) return { status: 409, body: { error: '保存天數最多 3650 天', code: 'retention_too_long', max: RETENTION_MAX_DAYS } };
  }
  const effective = effectiveProofDaysFake(next, studioDays);
  const floor = effective > 0 ? new Date(nowMs + (action === 'postpone' ? RETENTION_POSTPONE_DAYS : RETENTION_NOTICE_DAYS) * DAY_MS).toISOString() : null;
  project.proof_retention_days = next;
  if (floor && (!project.proofs_delete_next_at || project.proofs_delete_next_at < floor)) project.proofs_delete_next_at = floor;
  return { status: 200, body: { ok: true, proof_retention: proofRetentionInfoFake(project, studioDays, true, nowMs) } };
}
