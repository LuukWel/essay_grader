// End-to-end smoke test against a running server.
//
// Ollama is pointed at an unreachable port, so the precompute and cohort runs fail; the
// test checks that those failures are recorded correctly. Use a throwaway database:
//
//   npm run build
//   GRADING_DB_PATH=/tmp/smoke.db OLLAMA_BASE_URL=http://127.0.0.1:9 LLM_PRECOMPUTE_TIMEOUT_MS=3000 npm start -- -p 3123
//   npm run smoke            # in a second terminal; SMOKE_URL overrides http://localhost:3123
//
// Assumes the DEMO essay set (24 essays).

const BASE = process.env.SMOKE_URL || 'http://localhost:3123';
let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures++;
};
async function call(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, json, text };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Wait for the server
for (let i = 0; ; i++) {
  try { if ((await fetch(BASE + '/api/instance')).ok) break; } catch { /* not up yet */ }
  if (i > 60) throw new Error('server did not start');
  await sleep(1000);
}

// Pages and essay sets
const page = await call('GET', '/');
check('home page renders', page.status === 200 && page.text.includes('<html'), `HTTP ${page.status}`);
const sets = await call('GET', '/api/essay-sets');
check('DEMO essay set is listed', sets.json?.sets?.includes('DEMO'), JSON.stringify(sets.json?.sets));

// Session validation and creation
const bad = await call('POST', '/api/sessions', { participantId: 'P1', condition: 'cohort', essaySet: 'DEMO' });
check('invalid condition rejected with 400', bad.status === 400, bad.json?.error);
const malformed = await fetch(BASE + '/api/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{oops' });
check('malformed JSON gives 400, not 500', malformed.status === 400, `HTTP ${malformed.status}`);

const created = await call('POST', '/api/sessions', {
  participantId: 'SMOKE-1', condition: 'baseline', essaySet: 'DEMO', precomputeGrades: true, useCachedAssessments: true,
});
const sessionId = created.json?.sessionId;
check('baseline session created with 24 essays', created.status === 200 && created.json?.essays?.length === 24,
  `HTTP ${created.status}, ${created.json?.essays?.length} essays`);
const resumed = await call('POST', '/api/sessions', {
  participantId: 'SMOKE-1', condition: 'baseline', essaySet: 'DEMO', precomputeGrades: true, useCachedAssessments: true,
});
check('same participant resumes the session', resumed.json?.resumed === true && resumed.json?.sessionId === sessionId);
check('session comes with the criteria of its rubric',
  JSON.stringify(resumed.json?.criteria?.map((c) => c.name)) === '["Content","Organization","Language"]',
  JSON.stringify(resumed.json?.criteria?.map((c) => c.name)));

const essays = created.json.essays;
const e1 = essays[0];

// Grades
const g = await call('POST', `/api/sessions/${sessionId}/grades`, {
  essayId: e1.id, criterionName: 'Content', criterionId: 1, teacher_score: 4, teacher_justification: 'Clear position.',
});
check('valid grade saved and returned', g.status === 200 && g.json?.grade?.teacher_score === 4, `HTTP ${g.status}`);
const g2 = await call('POST', `/api/sessions/${sessionId}/grades`, { essayId: e1.id, criterionName: 'Content', criterionId: 1, teacher_justification: 'Edited.' });
check('partial update keeps the score', g2.json?.grade?.teacher_score === 4 && g2.json?.grade?.teacher_justification === 'Edited.');
const g3 = await call('POST', `/api/sessions/${sessionId}/grades`, { essayId: e1.id, criterionName: 'Content', criterionId: 1, teacher_score: 7 });
check('out-of-range score rejected with 400', g3.status === 400, g3.json?.error);

// The server owns the original AI score and calculated averages.
const aiFirst = await call('POST', `/api/sessions/${sessionId}/grades`, {
  essayId: e1.id, criterionName: 'Content', criterionId: 1, ai_score: 3, original_ai_score: 5,
});
check('first AI score comes from the saved score', aiFirst.json?.grade?.original_ai_score === 3);
const aiRevised = await call('POST', `/api/sessions/${sessionId}/grades`, {
  essayId: e1.id, criterionName: 'Content', criterionId: 1, ai_score: 4, original_ai_score: 1,
});
check('revising AI preserves its original and the teacher score', aiRevised.json?.grade?.original_ai_score === 3
  && aiRevised.json?.grade?.ai_score === 4 && aiRevised.json?.grade?.teacher_score === 4);
const scored = await call('GET', `/api/sessions/${sessionId}/essays/${e1.id}`);
check('essay detail exposes source fields and calculated averages', scored.json?.essay?.dataset_essay_id
  && typeof scored.json?.essay?.essay_text === 'string' && scored.json?.essay?.avg_ai_score === 4);
await call('POST', `/api/sessions/${sessionId}/grades`, {
  essayId: e1.id, criterionName: 'Content', criterionId: 1, ai_score: null,
});
const cleared = await call('GET', `/api/sessions/${sessionId}/essays/${e1.id}`);
check('clearing AI immediately clears its mean and preserves its original', cleared.json?.essay?.avg_ai_score === null
  && cleared.json?.grades?.find((g) => g.criterion_id === 1)?.original_ai_score === 3);

// A second session, to test cross-session access
const other = await call('POST', '/api/sessions', { participantId: 'SMOKE-2', condition: 'baseline', essaySet: 'DEMO', precomputeGrades: false });
const foreign = await call('POST', `/api/sessions/${other.json.sessionId}/grades`, {
  essayId: e1.id, criterionName: 'Content', criterionId: 1, teacher_score: 3,
});
check('essay of another session rejected with 404', foreign.status === 404, foreign.json?.error);

// Highlights
const text = e1.content.slice(0, 20);
const h = await call('POST', `/api/sessions/${sessionId}/highlights`, { essayId: e1.id, criterionName: 'Content', startIndex: 0, endIndex: 20, text });
check('highlight saved', h.status === 200 && typeof h.json?.id === 'number', `HTTP ${h.status}`);
const hBad = await call('POST', `/api/sessions/${sessionId}/highlights`, { essayId: e1.id, criterionName: 'Content', startIndex: 0, endIndex: 20, text: 'not the essay text!!' });
check('highlight with mismatching text rejected', hBad.status === 400, hBad.json?.error);
const hDel = await call('DELETE', `/api/sessions/${sessionId}/highlights?id=${h.json?.id}`);
check('highlight deleted', hDel.status === 200);

// Benchmarks
const b = await call('POST', `/api/sessions/${sessionId}/benchmarks`, { criterionName: 'Content', essayId: e1.id, type: '4', score: 4 });
const bl = await call('GET', `/api/sessions/${sessionId}/benchmarks?criterion=Content`);
check('benchmark set and listed with its essay', b.status === 200 && bl.json?.benchmarks?.[0]?.filename === e1.filename);

// Essay completion and research log
const done = await call('PATCH', `/api/sessions/${sessionId}/essays/${e1.id}`, { grading_status: 'graded', overall_grade: 5 });
const doneBad = await call('PATCH', `/api/sessions/${sessionId}/essays/${e1.id}`, { grading_status: 'finished' });
check('essay marked graded; unknown status rejected', done.status === 200 && doneBad.status === 400);
check('completion returns the saved teacher mean, ignoring the client average', done.json?.essay?.overall_grade === 4);
const log = await call('POST', '/api/logs', { sessionId, actionType: 'essay_opened', essayId: e1.id, actionDetail: { source: 'smoke' } });
const logBad = await call('POST', '/api/logs', { sessionId: 'no-such-session', actionType: 'essay_opened' });
check('research event logged; unknown session gets 404', log.status === 200 && logBad.status === 404);
const logForeign = await call('POST', '/api/logs', { sessionId: other.json.sessionId, actionType: 'essay_opened', essayId: e1.id });
check('event about an essay of another session rejected with 404', logForeign.status === 404, logForeign.json?.error);

// AI precompute without Ollama: every item fails
const pre = await call('POST', `/api/sessions/${sessionId}/precompute`);
check('precompute started', pre.status === 202, pre.json?.status);
let status;
for (let i = 0; i < 60; i++) {
  status = (await call('GET', `/api/sessions/${sessionId}/precompute`)).json;
  if (!status.running) break;
  await sleep(1000);
}
check('precompute run recorded as failed, not complete',
  status.run?.status === 'failed' && status.grades_precomputed === false,
  `status ${status.run?.status}, ${status.run?.processed_items} ok / ${status.run?.failed_items} failed of ${status.run?.expected_items}`);
check('every essay x criterion counted', status.run?.expected_items === 72
  && status.run?.processed_items + status.run?.failed_items === 72);
check('teacher grade survives the failed precompute',
  (await call('GET', `/api/sessions/${sessionId}/grades?essayId=${e1.id}`)).json?.grades?.find((x) => x.criterion_name === 'Content')?.teacher_score === 4);

// Cohort processing without models: the run fails
const dash = await call('POST', '/api/sessions', { participantId: 'SMOKE-3', condition: 'dashboard', essaySet: 'DEMO', precomputedK: 4, precomputeGrades: false });
const dashId = dash.json?.sessionId;
const proc = await call('POST', `/api/sessions/${dashId}/process`);
check('cohort processing started', proc.status === 202, proc.json?.status);
const procAgain = await call('POST', `/api/sessions/${dashId}/process`);
check('second start while running does not start another run', procAgain.status === 202);
let sess;
for (let i = 0; i < 120; i++) {
  sess = (await call('GET', `/api/sessions/${dashId}`)).json;
  if (['complete', 'error'].includes(sess.session.processing_status)) break;
  await sleep(1000);
}
check('cohort run ends in error with a reason', sess.session.processing_status === 'error' && sess.runs?.cohort?.status === 'failed',
  `${sess.session.processing_status} / ${sess.runs?.cohort?.status}: ${String(sess.runs?.cohort?.error_message).slice(0, 160)}`);
check('cohort run counts the essays that failed before it stopped', sess.runs?.cohort?.failed_items === 24,
  `${sess.runs?.cohort?.failed_items} failed of ${sess.runs?.cohort?.expected_items}`);
check('failure messages say Ollama could not be reached',
  String(status.run?.error_message).includes('Cannot reach Ollama at http://127.0.0.1:9'),
  String(status.run?.error_message).slice(0, 140));

// Export and completion
const exp = await call('GET', `/api/export/all?sessionId=${sessionId}`);
const opened = exp.json?.action_logs?.find((l) => l.action_type === 'essay_opened');
check('export decodes the event detail to an object', opened?.action_detail?.source === 'smoke', JSON.stringify(opened?.action_detail));
const complete = await call('PATCH', `/api/sessions/${sessionId}`, { complete: true });
const completeBad = await call('PATCH', '/api/sessions/no-such-session', { complete: true });
check('session completed; unknown session gets 404', complete.status === 200 && completeBad.status === 404);

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
