// Practice Mail: a pretend email app where people can safely practise with Naomi.
// Element ids here (compose, sent, row-alysa, addr, to, body, send) are what the practice guide points at.

const main = document.getElementById('main');
const composer = document.getElementById('composer');
const toast = document.getElementById('toast');

const INBOX = [
  { who: 'Rafi', what: 'Photos from the weekend' },
  { who: 'City Pharmacy', what: 'Your prescription is ready to collect' },
  { who: 'Nasrin', what: 'Tea on Friday afternoon?' },
];
const SENT = [
  {
    id: 'row-alysa',
    who: 'Alysa',
    what: 'Happy birthday, my darling',
    to: 'alysa2002@gmail.com',
    body: 'Wishing you the happiest birthday. I am so proud of you. Love, Nanu',
  },
  { who: 'Rafi', what: 'Thank you for the lovely photos', to: 'rafi.hasan@gmail.com', body: 'They made my day.' },
];

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  Object.assign(node, props);
  node.append(...children);
  return node;
}

function setFolder(name) {
  document.getElementById('inbox').classList.toggle('active', name === 'inbox');
  document.getElementById('sent').classList.toggle('active', name === 'sent');
  const list = name === 'inbox' ? INBOX : SENT;
  main.replaceChildren(
    el('div', { className: 'heading', textContent: name === 'inbox' ? 'Inbox' : 'Sent emails' }),
    ...list.map((m) => {
      const row = el('button', { className: 'row' }, el('b', { textContent: m.who }), el('span', { textContent: m.what }));
      if (m.id) row.id = m.id;
      if (m.to) row.addEventListener('click', () => openMessage(m));
      return row;
    }),
  );
}

function openMessage(m) {
  main.replaceChildren(
    el(
      'div',
      { className: 'message' },
      el('h2', { textContent: m.what }),
      el('div', { className: 'meta' }, 'To: ', el('span', { className: 'addr', id: 'addr', textContent: m.to })),
      el('p', { textContent: m.body }),
    ),
  );
}

function showToast(text) {
  toast.textContent = text;
  toast.hidden = false;
  setTimeout(() => (toast.hidden = true), 4000);
}

document.getElementById('inbox').addEventListener('click', () => setFolder('inbox'));
document.getElementById('sent').addEventListener('click', () => setFolder('sent'));
document.getElementById('compose').addEventListener('click', () => {
  composer.hidden = false;
});
document.getElementById('closeCompose').addEventListener('click', () => {
  composer.hidden = true;
});
document.getElementById('send').addEventListener('click', () => {
  composer.hidden = true;
  showToast('Sent! (Practice only — nothing was really sent.)');
  for (const id of ['to', 'subject', 'body']) document.getElementById(id).value = '';
});

// Used by Naomi to find where things are on screen (CSS pixels inside this window).
window.naomiLocate = (id) => {
  const node = document.getElementById(id);
  if (!node || node.offsetParent === null) return null;
  const r = node.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
};

setFolder('inbox');
