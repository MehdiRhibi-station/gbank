// Shared with the standalone review page. Choices are tied to exact images,
// not array positions, so rerenders/reordering cannot approve a different crop.
export function restoreDecisions(questions, saved = {}) {
  return questions.map(q => {
    const entry = saved[q.id];
    return q.linked && entry?.storagePath === q.storagePath &&
      ['approved', 'rejected'].includes(entry.decision) ? entry.decision : 'pending';
  });
}

export function reviewPersistenceScript() {
  return `
const restoreDecisions = ${restoreDecisions.toString()};
const reviewKey = 'toodle-crop-review-v2-' + manifest.course;
let savedChoices = {};
try { savedChoices = JSON.parse(localStorage.getItem(reviewKey) || '{}') || {}; } catch {}
const decisions = restoreDecisions(manifest.questions, savedChoices);
function persistDecisions() {
  manifest.questions.forEach((q, i) => {
    if (q.linked) savedChoices[q.id] = {storagePath:q.storagePath, decision:decisions[i]};
  });
  try { localStorage.setItem(reviewKey, JSON.stringify(savedChoices)); }
  catch { document.getElementById('save-status').textContent = 'Browser saving unavailable — download decisions before closing.'; }
}
document.querySelectorAll('button[data-index]').forEach(button => {
  const i = Number(button.dataset.index);
  button.disabled = !manifest.questions[i].linked;
  button.classList.toggle('selected', button.dataset.decision === decisions[i]);
});
document.addEventListener('click', event => {
  if (event.target.closest('button[data-index]')) persistDecisions();
});
`;
}
