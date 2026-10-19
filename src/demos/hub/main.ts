/** The demo hub at `/demos/`: one tile per registered demo, newest first. */
import { demosNewestFirst, type DemoStatus } from '../registry';

const STATUS_LABEL: Record<DemoStatus, string> = {
  dev: 'dev bench',
  signoff: 'needs sign-off',
  approved: 'approved',
};

const list = document.querySelector<HTMLUListElement>('#demos');
const stamp = document.querySelector<HTMLSpanElement>('#stamp');
if (!list || !stamp) throw new Error('demos/index.html is missing #demos or #stamp');

const commit = __DEMO_COMMIT__;
stamp.textContent = /^[0-9a-f]{40}$/.test(commit) ? commit.slice(0, 7) : commit;
stamp.title = `commit ${commit}`;

function span(className: string, text: string): HTMLSpanElement {
  const s = document.createElement('span');
  s.className = className;
  s.textContent = text;
  return s;
}

for (const demo of demosNewestFirst()) {
  const li = document.createElement('li');
  const a = document.createElement('a');
  a.className = 'tile';
  a.href = `./${demo.slug}.html`;
  a.dataset.slug = demo.slug;
  const row = document.createElement('div');
  row.className = 'row';
  row.append(
    span('title', demo.title),
    span(`badge ${demo.status}`, STATUS_LABEL[demo.status]),
    span('badge milestone', demo.milestone),
  );
  a.append(row, span('check', demo.whatToCheck), span('meta', `${demo.packet} · ${demo.updated}`));
  li.append(a);
  list.append(li);
}
document.body.dataset.ready = '1';
